import { defineConfig } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const profile = process.env.FULL_CIRCLE_PROFILE;
if (profile !== "ha" && profile !== "non-ha") throw new Error("FULL_CIRCLE_PROFILE must be ha or non-ha.");
const diagnosticsToken = process.env.FULL_CIRCLE_DIAGNOSTICS_TOKEN;
if (!diagnosticsToken) throw new Error("FULL_CIRCLE_DIAGNOSTICS_TOKEN must contain the runtime-generated test credential.");
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const plan = JSON.parse(readFileSync(resolve(repositoryRoot, "examples/full-circle/full-circle.plan.json"), "utf8"));
const selectedPlan = plan.profiles?.[profile];
if (plan.schemaVersion !== 1 || selectedPlan === undefined) throw new Error("The shared full-circle plan is invalid.");
const redis = process.env.REDIS_TEST_ENDPOINT ?? "127.0.0.1:6379";
const instances = selectedPlan.instances;
const entryPort = selectedPlan.entryPort;
const readinessTimeout = plan.timeouts.readinessSeconds * 1000;
const packagedApplicationDirectory = resolve(repositoryRoot, "artifacts/full-circle/consumer-bin/Release/net10.0");
const packagedApplication = "Cormier.Realtime.Example.FullCircle.dll";
const forwardedRedisConfiguration = Object.fromEntries([
  "Redis__User",
  "Redis__Password",
  "Redis__Ssl",
  "Redis__SentinelServiceName",
  "Redis__SentinelPassword",
].flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]]]));
const appServers = instances.map(instance => ({
  command: `dotnet ${packagedApplication}`,
  cwd: packagedApplicationDirectory,
  url: `http://127.0.0.1:${instance.port}/health`,
  timeout: readinessTimeout,
  reuseExistingServer: false,
  env: {
    ...forwardedRedisConfiguration,
    ASPNETCORE_URLS: `http://127.0.0.1:${instance.port}`,
    FullCircle__Topology: profile,
    FullCircle__InstanceName: instance.name,
    Redis__Endpoint: redis,
    Redis__InstancePrefix: plan.redis.instancePrefix,
    Realtime__AllowedOrigins__0: `http://127.0.0.1:${entryPort}`,
    Diagnostics__Enabled: "true",
    Diagnostics__ProductionEnabled: "true",
    Diagnostics__AuthorizationPolicy: "Cormier.Diagnostics.Operator",
    Diagnostics__OperatorToken: diagnosticsToken,
    Diagnostics__AllowedOrigins__0: `http://127.0.0.1:${entryPort}`,
    Diagnostics__AllowedNetworks__0: "127.0.0.0/8",
  },
}));
if (profile === "ha") {
  appServers.push({
    command: "node ./test/round-robin-proxy.mjs",
    url: `http://127.0.0.1:${entryPort}/health`,
    timeout: readinessTimeout,
    reuseExistingServer: false,
    env: {
      REALTIME_BROWSER_PROXY_PORT: String(entryPort),
      REALTIME_BROWSER_BACKENDS: instances.map(instance => `http://127.0.0.1:${instance.port}`).join(","),
    },
  });
}

export default defineConfig({
  testDir: "./test/full-circle",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  workers: 1,
  fullyParallel: false,
  reporter: process.env.CI ? [["line"], ["html", { outputFolder: "../../artifacts/full-circle/playwright-report", open: "never" }]] : "line",
  outputDir: "../../artifacts/full-circle/test-results",
  use: {
    baseURL: `http://127.0.0.1:${entryPort}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: appServers,
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
