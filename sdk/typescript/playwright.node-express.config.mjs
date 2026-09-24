import { defineConfig } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const redisEndpoint = process.env.REDIS_TEST_ENDPOINT ?? "127.0.0.1:6379";
const redisUrl = process.env.REDIS_TEST_URL ?? `redis://${redisEndpoint}`;
const frontendOrigin = "http://127.0.0.1:15100";
const gatewayOrigin = "http://127.0.0.1:15101";
const readinessTimeout = 60_000;
process.env.REFERENCE_STACK = "Node.js / Express";
process.env.REFERENCE_BASE_URL = frontendOrigin;
process.env.REFERENCE_GATEWAY_URL = gatewayOrigin;

export default defineConfig({
  testDir: "./test/reference-adapters",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  workers: 1,
  fullyParallel: false,
  reporter: process.env.CI ? [["line"], ["html", { outputFolder: "../../artifacts/node-express/playwright-report", open: "never" }]] : "line",
  outputDir: "../../artifacts/node-express/test-results",
  use: {
    baseURL: frontendOrigin,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: [
    {
      command: "dotnet run --project examples/full-circle/Cormier.Realtime.Example.FullCircle.csproj --configuration Release --no-build --no-restore",
      cwd: repositoryRoot,
      url: `${gatewayOrigin}/health`,
      timeout: readinessTimeout,
      reuseExistingServer: false,
      env: {
        ASPNETCORE_ENVIRONMENT: "Automation",
        ASPNETCORE_URLS: gatewayOrigin,
        FullCircle__Topology: "non-ha",
        FullCircle__InstanceName: "gateway-a",
        Redis__Endpoint: redisEndpoint,
        Redis__InstancePrefix: "cormier:node-express-tests",
        Realtime__SessionSource: "Cookie",
        Realtime__AllowedOrigins__0: frontendOrigin,
      },
    },
    {
      command: "node ./src/server.mjs",
      cwd: resolve(repositoryRoot, "examples/node-express"),
      url: `${frontendOrigin}/health`,
      timeout: readinessTimeout,
      reuseExistingServer: false,
      env: {
        LISTEN_HOST: "127.0.0.1",
        PORT: "15100",
        TRUST_PROXY_HOPS: "0",
        PUBLIC_ORIGIN: frontendOrigin,
        GATEWAY_URL: gatewayOrigin,
        REDIS_URL: redisUrl,
        SESSION_SECRET: "browser-fixture-secret-with-at-least-32-characters",
        SESSION_LIFETIME_SECONDS: "1200",
        INSTANCE_NAME: "node-express-a",
        TOPOLOGY: "non-ha",
        REDIS_INSTANCE_PREFIX: "cormier:node-express-tests",
        REDIS_SESSION_KEY_PREFIX: "sessions",
        ALLOWED_TENANTS: "tenant-a,tenant-b",
        ALLOWED_USERS: "user-a,user-b",
        SHARED_ASSET_ROOT: resolve(repositoryRoot, "examples/shared-web/dist/optimized"),
      },
    },
  ],
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
