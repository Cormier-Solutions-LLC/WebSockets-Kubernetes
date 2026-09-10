import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
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
const redisEndpoint = process.env[plan.redis.endpointEnvironment] ?? plan.redis.defaultEndpoint;
const upstreamPackageSource = process.env.NUGET_UPSTREAM_SOURCE ?? "https://api.nuget.org/v3/index.json";
const candidateRevisionProperties = [
  "-p:SourceRevisionId=0000000000000000000000000000000000000000",
  "-p:RepositoryCommit=0000000000000000000000000000000000000000",
];
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
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error(`Command exceeded ${plan.timeouts.commandSeconds} seconds.`)); }, commandTimeout);
    child.on("error", reject);
    child.on("exit", code => { clearTimeout(timer); code === 0 ? accept() : reject(new Error(`${file} exited with code ${code}.`)); });
  });
}

async function verifyRedis() {
  await command("node", ["--input-type=module", "--eval", "import {createClient} from 'redis'; const c=createClient({url:process.env.FULL_CIRCLE_REDIS_URL}); await c.connect(); if(await c.ping()!=='PONG') process.exit(1); await c.quit();"], {
    cwd: resolve(repositoryRoot, "sdk/typescript"),
    env: { FULL_CIRCLE_REDIS_URL: `redis://${redisEndpoint}` },
  });
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
  await command("node", ["--input-type=module", "--eval", "import {createClient} from 'redis'; const c=createClient({url:process.env.FULL_CIRCLE_REDIS_URL}); await c.connect(); const script=\"local c='0' repeat local r=redis.call('SCAN',c,'MATCH',ARGV[1],'COUNT',100); c=r[1]; if #r[2]>0 then redis.call('UNLINK',unpack(r[2])) end until c=='0' return 1\"; await c.sendCommand(['EVAL',script,'0',process.env.FULL_CIRCLE_PATTERN]); await c.quit();"], {
    cwd: resolve(repositoryRoot, "sdk/typescript"),
    env: { FULL_CIRCLE_REDIS_URL: `redis://${redisEndpoint}`, FULL_CIRCLE_PATTERN: `${escapeRedisGlob(plan.redis.instancePrefix)}:*` },
  });
}

function xml(value) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

async function buildPackageConsumer() {
  const feed = resolve(evidenceRoot, "feed");
  const consumerOutputRoot = resolve(evidenceRoot, "consumer-bin");
  const consumerOutput = consumerOutputRoot + "/";
  const consumerLockName = {
    linux: "package-consumer.linux.packages.lock.json",
    win32: "package-consumer.win32.packages.lock.json",
  }[process.platform];
  if (consumerLockName === undefined) {
    throw new Error(`Package-consumer validation is not configured for ${process.platform}.`);
  }
  const consumerLock = resolve(repositoryRoot, "examples/full-circle", consumerLockName);
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
    await command("dotnet", ["pack", project, "--configuration", "Release", "--no-build", "--output", feed, ...candidateRevisionProperties]);
  }
  await command("pwsh", ["-NoLogo", "-NoProfile", "-File", "scripts/Normalize-NuGetPackages.ps1", "-PackageDirectory", feed]);
  await writeFile(config, `<configuration><config><add key="globalPackagesFolder" value="${xml(packages)}" /></config><packageSources><clear /><add key="local" value="${xml(feed)}" /><add key="upstream" value="${xml(upstreamPackageSource)}" /></packageSources><packageSourceMapping><packageSource key="local"><package pattern="Cormier.Realtime.*" /></packageSource><packageSource key="upstream"><package pattern="Microsoft.*" /><package pattern="StackExchange.Redis" /><package pattern="RESPite" /><package pattern="System.*" /></packageSource></packageSourceMapping></configuration>\n`);
  const project = "examples/full-circle/Cormier.Realtime.Example.FullCircle.csproj";
  const properties = [
    "-p:UseProjectReferences=false",
    `-p:NuGetLockFilePath=${consumerLock}`,
    `-p:BaseOutputPath=${consumerOutput}`,
  ];
  await command("dotnet", ["restore", project, "--locked-mode", "--configfile", config, ...properties]);
  await command("dotnet", ["build", project, "--configuration", "Release", "--no-restore", ...properties]);
  const endpointsPath = resolve(consumerOutput, "Release/net10.0/Cormier.Realtime.Example.FullCircle.staticwebassets.endpoints.json");
  const endpoints = await readFile(endpointsPath, "utf8");
  if (!endpoints.includes("_content/Cormier.Realtime.Browser/cormier-realtime.iife.js")) {
    throw new Error("The package consumer did not expose the generated browser static asset route.");
  }
  await command("dotnet", ["restore", project]);
  log("pass", action, "Clean local-feed package consumer built.", { packageSource: "local", browserAssetRoute: "present" });
}

try {
  if (["bootstrap", "update", "recover"].includes(action)) {
    await command(executable("npm"), ["ci", "--ignore-scripts"], { cwd: resolve(repositoryRoot, "sdk/typescript") });
    await command(executable("npm"), ["run", "build", "--silent"], { cwd: resolve(repositoryRoot, "sdk/typescript") });
    await command("dotnet", ["restore", "examples/full-circle/Cormier.Realtime.Example.FullCircle.csproj"]);
    // The application selects net10.0 from the multi-targeted contracts project. Build that package
    // explicitly so its netstandard2.0 asset also exists before the clean local-feed pack.
    await command("dotnet", ["build", "src/Cormier.Realtime.Contracts/Cormier.Realtime.Contracts.csproj", "--configuration", "Release", "--no-restore", "--no-incremental", ...candidateRevisionProperties]);
    await command("dotnet", ["build", "examples/full-circle/Cormier.Realtime.Example.FullCircle.csproj", "--configuration", "Release", "--no-restore", "--no-incremental", ...candidateRevisionProperties]);
    await buildPackageConsumer();
    await verifyRedis();
  } else if (action === "validate") {
    await verifyRedis();
    await command(executable("npx"), ["playwright", "test", "--config", "playwright.full-circle.config.mjs"], {
      cwd: resolve(repositoryRoot, "sdk/typescript"),
      env: { FULL_CIRCLE_PROFILE: profileName, REDIS_TEST_ENDPOINT: redisEndpoint },
    });
  } else if (action === "run") {
    const instance = profile.instances[0];
    await command("dotnet", ["run", "--project", "examples/full-circle/Cormier.Realtime.Example.FullCircle.csproj", "--configuration", "Release", "--no-build", "--no-restore"], {
      env: {
        ASPNETCORE_URLS: `http://127.0.0.1:${instance.port}`,
        FullCircle__Topology: profileName,
        FullCircle__InstanceName: instance.name,
        Redis__Endpoint: redisEndpoint,
        Redis__InstancePrefix: plan.redis.instancePrefix,
        Realtime__AllowedOrigins__0: `http://127.0.0.1:${profile.entryPort}`,
      },
    });
  } else if (action === "cleanup" || action === "rollback") {
    await cleanRedisFixtures();
    const resolvedEvidence = resolve(evidenceRoot);
    if (!resolvedEvidence.startsWith(resolve(repositoryRoot, "artifacts") + "\\") && !resolvedEvidence.startsWith(resolve(repositoryRoot, "artifacts") + "/")) {
      throw new Error("Refusing cleanup outside the repository artifacts directory.");
    }
    await rm(resolvedEvidence, { recursive: true, force: true });
  }
  await mkdir(evidenceRoot, { recursive: true });
  await writeFile(resolve(evidenceRoot, `${action}-${profileName}.json`), `${JSON.stringify({ ...normalized, status: "passed", completedAt: new Date().toISOString() }, null, 2)}\n`);
  log("pass", action, "Lifecycle action completed.", { profile: profileName });
} catch (error) {
  await writeFile(resolve(evidenceRoot, `${action}-${profileName}.json`), `${JSON.stringify({ ...normalized, status: "failed", message: error.message, completedAt: new Date().toISOString() }, null, 2)}\n`);
  log("error", action, error.message);
  process.exit(1);
}
