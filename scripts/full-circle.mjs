import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const planPath = resolve(repositoryRoot, "examples/full-circle/full-circle.plan.json");
const evidenceRoot = resolve(repositoryRoot, "artifacts/full-circle");
const action = process.argv[2];
const profileFlag = process.argv.indexOf("--profile");
const profileName = profileFlag >= 0 ? process.argv[profileFlag + 1] : undefined;
const dryRun = process.argv.includes("--dry-run");
const executable = name => process.platform === "win32" && (name === "npm" || name === "npx") ? `${name}.cmd` : name;
const validActions = new Set(["plan", "bootstrap", "run", "validate", "cleanup", "update", "rollback", "recover"]);

function log(level, phase, message, fields = {}) {
  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level, phase, message, ...fields })}\n`);
}

function fail(message, exitCode = 2) {
  log("error", action ?? "initialize", message);
  process.exit(exitCode);
}

if (!validActions.has(action)) fail("Action must be plan, bootstrap, run, validate, cleanup, update, rollback, or recover.");
if (profileName !== "ha" && profileName !== "non-ha") fail("--profile must explicitly identify ha or non-ha.");

const plan = JSON.parse(await readFile(planPath, "utf8"));
if (plan.schemaVersion !== 1 || !plan.profiles?.[profileName]) fail("The shared plan schema or selected profile is invalid.");
const profile = plan.profiles[profileName];
const externalRedisEndpoint = process.env[plan.redis.endpointEnvironment];
const localRedisPort = process.env.FULL_CIRCLE_REDIS_PORT;
if (localRedisPort !== undefined && (!/^\d+$/.test(localRedisPort) || Number(localRedisPort) < 1 || Number(localRedisPort) > 65535)) {
  fail("FULL_CIRCLE_REDIS_PORT must be a TCP port from 1 through 65535.");
}
const redisEndpoint = externalRedisEndpoint ?? (localRedisPort === undefined ? plan.redis.defaultEndpoint : `127.0.0.1:${localRedisPort}`);
const composeFile = resolve(repositoryRoot, plan.redis.composeFile);
const upstreamPackageSource = process.env.NUGET_UPSTREAM_SOURCE ?? "https://api.nuget.org/v3/index.json";
const upstreamPackageEnvironment = { NUGET_UPSTREAM_SOURCE: upstreamPackageSource };
const normalized = {
  schemaVersion: plan.schemaVersion,
  action,
  profile: profileName,
  instances: profile.instances,
  entryPort: profile.entryPort,
  guarantee: profile.guarantee,
  redis: { configured: Boolean(redisEndpoint), instancePrefix: plan.redis.instancePrefix },
  dryRun,
};
log("info", "plan", "Normalized lifecycle plan.", normalized);
if (action === "plan" || dryRun) process.exit(0);

await mkdir(evidenceRoot, { recursive: true });
const commandTimeout = plan.timeouts.commandSeconds * 1000;
async function command(file, args, options = {}) {
  log("info", action, "Running command.", { command: file, arguments: args });
  await new Promise((accept, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd ?? repositoryRoot,
      env: { ...process.env, ...options.env },
      stdio: "inherit",
      shell: process.platform === "win32" && file.endsWith(".cmd"),
    });
    const forwardSignal = signal => {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    };
    const forwardInterrupt = () => forwardSignal("SIGINT");
    const forwardTermination = () => forwardSignal("SIGTERM");
    process.once("SIGINT", forwardInterrupt);
    process.once("SIGTERM", forwardTermination);
    const removeSignalHandlers = () => {
      process.removeListener("SIGINT", forwardInterrupt);
      process.removeListener("SIGTERM", forwardTermination);
    };
    const timeout = options.timeout === false ? undefined : options.timeout ?? commandTimeout;
    const timer = timeout === undefined
      ? undefined
      : setTimeout(() => { child.kill("SIGTERM"); reject(new Error(`Command exceeded ${timeout / 1000} seconds.`)); }, timeout);
    child.on("error", error => {
      removeSignalHandlers();
      reject(error);
    });
    child.on("exit", code => {
      removeSignalHandlers();
      if (timer !== undefined) clearTimeout(timer);
      code === 0 ? accept() : reject(new Error(`${file} exited with code ${code}.`));
    });
  });
}

async function verifyRedis() {
  await command("node", [resolve(repositoryRoot, "sdk/typescript/scripts/redis-fixtures.mjs"), "ping"], {
    cwd: resolve(repositoryRoot, "sdk/typescript"),
    env: { Redis__Endpoint: redisEndpoint },
  });
}

async function ensureDependencies() {
  if (externalRedisEndpoint === undefined) {
    await command("docker", ["compose", "--file", composeFile, "up", "--detach", "--wait"]);
  }
  await verifyRedis();
}

async function stopDependencies() {
  if (externalRedisEndpoint === undefined) {
    await command("docker", ["compose", "--file", composeFile, "down", "--remove-orphans"]);
  }
}

function escapeRedisGlob(value) {
  let escaped = "";
  for (const character of value) {
    escaped += "\\*?[]".includes(character) ? `\\${character}` : character;
  }
  return escaped;
}

async function cleanRedisFixtures() {
  if (typeof plan.redis.instancePrefix !== "string" || plan.redis.instancePrefix.length === 0) {
    throw new Error("Redis fixture cleanup requires a non-empty instance prefix.");
  }
  await command("node", [resolve(repositoryRoot, "sdk/typescript/scripts/redis-fixtures.mjs"), "cleanup"], {
    cwd: resolve(repositoryRoot, "sdk/typescript"),
    env: { Redis__Endpoint: redisEndpoint, FULL_CIRCLE_PATTERN: `${escapeRedisGlob(plan.redis.instancePrefix)}:*` },
    timeout: plan.timeouts.cleanupSeconds * 1000,
  });
}

function xml(value) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

async function writeProjectReferenceConfig() {
  const config = resolve(evidenceRoot, "NuGet.ProjectReferences.Config");
  await writeFile(config, `<configuration><packageSources><clear /><add key="upstream" value="%NUGET_UPSTREAM_SOURCE%" /></packageSources></configuration>\n`);
  return config;
}

async function buildPackageConsumer() {
  const feed = resolve(evidenceRoot, "feed");
  const consumerOutputRoot = resolve(evidenceRoot, "consumer-bin");
  const consumerOutput = consumerOutputRoot + "/";
  const consumerLockTemplate = resolve(repositoryRoot, "examples/full-circle/package-consumer.packages.lock.json");
  const consumerLock = resolve(evidenceRoot, "consumer-packages.lock.json");
  const packages = resolve(evidenceRoot, "packages");
  const config = resolve(evidenceRoot, "NuGet.Config");
  await rm(feed, { recursive: true, force: true });
  await rm(packages, { recursive: true, force: true });
  await rm(consumerOutputRoot, { recursive: true, force: true });
  await mkdir(feed, { recursive: true });
  for (const project of [
    "src/Cormier.Realtime.Contracts/Cormier.Realtime.Contracts.csproj",
    "src/Cormier.Realtime.Redis/Cormier.Realtime.Redis.csproj",
    "src/Cormier.Realtime.AspNetCore/Cormier.Realtime.AspNetCore.csproj",
    "src/Cormier.Realtime.Browser/Cormier.Realtime.Browser.csproj",
  ]) {
    await command("dotnet", ["pack", project, "--configuration", "Release", "--no-build", "--output", feed]);
  }
  const consumerLockGraph = JSON.parse(await readFile(consumerLockTemplate, "utf8"));
  const targetGraph = consumerLockGraph.dependencies?.["net10.0"];
  for (const [packageId, packageFile] of [
    ["Cormier.Realtime.AspNetCore", "Cormier.Realtime.AspNetCore.1.0.2-beta.nupkg"],
    ["Cormier.Realtime.Browser", "Cormier.Realtime.Browser.1.0.2-beta.nupkg"],
    ["Cormier.Realtime.Contracts", "Cormier.Realtime.Contracts.1.0.2-beta.nupkg"],
    ["Cormier.Realtime.Redis", "Cormier.Realtime.Redis.1.0.2-beta.nupkg"],
  ]) {
    if (targetGraph?.[packageId] === undefined) {
      throw new Error(`The committed consumer lock is missing ${packageId}.`);
    }
    targetGraph[packageId].contentHash = createHash("sha512").update(await readFile(resolve(feed, packageFile))).digest("base64");
  }
  await writeFile(consumerLock, `${JSON.stringify(consumerLockGraph, null, 2)}\n`);
  await writeFile(config, `<configuration><config><add key="globalPackagesFolder" value="${xml(packages)}" /></config><packageSources><clear /><add key="local" value="${xml(feed)}" /><add key="upstream" value="%NUGET_UPSTREAM_SOURCE%" /></packageSources><packageSourceMapping><packageSource key="local"><package pattern="Cormier.Realtime.*" /></packageSource><packageSource key="upstream"><package pattern="Microsoft.*" /><package pattern="OpenTelemetry" /><package pattern="OpenTelemetry.*" /><package pattern="StackExchange.Redis" /><package pattern="RESPite" /><package pattern="System.*" /></packageSource></packageSourceMapping></configuration>\n`);
  const project = "examples/full-circle/Cormier.Realtime.Example.FullCircle.csproj";
  const properties = [
    "-p:UseProjectReferences=false",
    `-p:NuGetLockFilePath=${consumerLock}`,
    `-p:BaseOutputPath=${consumerOutput}`,
  ];
  await command("dotnet", ["restore", project, "--locked-mode", "--configfile", config, ...properties], { env: upstreamPackageEnvironment });
  await command("dotnet", ["build", project, "--configuration", "Release", "--no-restore", ...properties]);
  const endpointsPath = resolve(consumerOutput, "Release/net10.0/Cormier.Realtime.Example.FullCircle.staticwebassets.endpoints.json");
  const endpoints = await readFile(endpointsPath, "utf8");
  if (!endpoints.includes("_content/Cormier.Realtime.Browser/cormier-realtime.iife.js")) {
    throw new Error("The package consumer did not expose the generated browser static asset route.");
  }
  const projectConfig = await writeProjectReferenceConfig();
  await command("dotnet", ["restore", project, "--locked-mode", "--configfile", projectConfig], { env: upstreamPackageEnvironment });
  log("pass", action, "Clean local-feed package consumer built.", { packageSource: "local", browserAssetRoute: "present" });
}

try {
  if (["bootstrap", "update", "recover"].includes(action)) {
    await ensureDependencies();
    await command(executable("npm"), ["ci", "--ignore-scripts"], { cwd: resolve(repositoryRoot, "sdk/typescript") });
    await command(executable("npm"), ["run", "build", "--silent"], { cwd: resolve(repositoryRoot, "sdk/typescript") });
    const projectConfig = await writeProjectReferenceConfig();
    await command("dotnet", ["restore", "examples/full-circle/Cormier.Realtime.Example.FullCircle.csproj", "--locked-mode", "--configfile", projectConfig], { env: upstreamPackageEnvironment });
    // The application selects net10.0 from the multi-targeted contracts project. Build that package
    // explicitly so its netstandard2.0 asset also exists before the clean local-feed pack.
    await command("dotnet", ["build", "src/Cormier.Realtime.Contracts/Cormier.Realtime.Contracts.csproj", "--configuration", "Release", "--no-restore", "--no-incremental"]);
    await command("dotnet", ["build", "examples/full-circle/Cormier.Realtime.Example.FullCircle.csproj", "--configuration", "Release", "--no-restore", "--no-incremental"]);
    await buildPackageConsumer();
  } else if (action === "validate") {
    await ensureDependencies();
    const diagnosticsToken = randomBytes(32).toString("hex");
    await command(executable("npx"), ["playwright", "test", "--config", "playwright.full-circle.config.mjs"], {
      cwd: resolve(repositoryRoot, "sdk/typescript"),
      env: {
        FULL_CIRCLE_PROFILE: profileName,
        FULL_CIRCLE_DIAGNOSTICS_TOKEN: diagnosticsToken,
        REDIS_TEST_ENDPOINT: redisEndpoint,
      },
    });
  } else if (action === "run") {
    await ensureDependencies();
    const instance = profile.instances[0];
    const application = resolve(repositoryRoot, "examples/full-circle/bin/Release/net10.0/Cormier.Realtime.Example.FullCircle.dll");
    await command("dotnet", [application], {
      cwd: resolve(repositoryRoot, "examples/full-circle"),
      env: {
        ASPNETCORE_ENVIRONMENT: "Development",
        ASPNETCORE_URLS: `http://127.0.0.1:${instance.port}`,
        FullCircle__Topology: profileName,
        Gateway__Topology: profileName,
        FullCircle__InstanceName: instance.name,
        Redis__Endpoint: redisEndpoint,
        Redis__InstancePrefix: plan.redis.instancePrefix,
        Realtime__AllowedOrigins__0: `http://127.0.0.1:${instance.port}`,
        Diagnostics__AllowedOrigins__0: `http://127.0.0.1:${instance.port}`,
      },
      timeout: false,
    });
  } else if (action === "cleanup" || action === "rollback") {
    try {
      await ensureDependencies();
      await cleanRedisFixtures();
      const resolvedEvidence = resolve(evidenceRoot);
      if (!resolvedEvidence.startsWith(resolve(repositoryRoot, "artifacts") + "\\") && !resolvedEvidence.startsWith(resolve(repositoryRoot, "artifacts") + "/")) {
        throw new Error("Refusing cleanup outside the repository artifacts directory.");
      }
      await rm(resolvedEvidence, { recursive: true, force: true });
    } finally {
      await stopDependencies();
    }
  }
  await mkdir(evidenceRoot, { recursive: true });
  await writeFile(resolve(evidenceRoot, `${action}-${profileName}.json`), `${JSON.stringify({ ...normalized, status: "passed", completedAt: new Date().toISOString() }, null, 2)}\n`);
  log("pass", action, "Lifecycle action completed.", { profile: profileName });
} catch (error) {
  await writeFile(resolve(evidenceRoot, `${action}-${profileName}.json`), `${JSON.stringify({ ...normalized, status: "failed", message: error.message, completedAt: new Date().toISOString() }, null, 2)}\n`);
  log("error", action, error.message);
  process.exit(1);
}
