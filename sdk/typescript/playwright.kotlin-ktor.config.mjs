import { defineConfig } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const redisEndpoint = process.env.REDIS_TEST_ENDPOINT ?? "127.0.0.1:6379";
const frontendOrigin = "http://127.0.0.1:15300";
const gatewayOrigin = "http://127.0.0.1:15301";
process.env.REFERENCE_STACK = "Kotlin / Ktor";
process.env.REFERENCE_BASE_URL = frontendOrigin;
process.env.REFERENCE_GATEWAY_URL = gatewayOrigin;

export default defineConfig({
  testDir: "./test/reference-adapters",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  workers: 1,
  fullyParallel: false,
  reporter: process.env.CI ? [["line"], ["html", { outputFolder: "../../artifacts/kotlin-ktor/playwright-report", open: "never" }]] : "line",
  outputDir: "../../artifacts/kotlin-ktor/test-results",
  use: {
    baseURL: frontendOrigin,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: [
    {
      command: "dotnet run --project examples/full-circle/Cormier.Realtime.Example.FullCircle.csproj --configuration Release --no-build --no-restore --no-launch-profile",
      cwd: repositoryRoot,
      url: `${gatewayOrigin}/health`,
      timeout: 60_000,
      reuseExistingServer: false,
      env: {
        ASPNETCORE_ENVIRONMENT: "Automation",
        ASPNETCORE_URLS: gatewayOrigin,
        FullCircle__Topology: "non-ha",
        FullCircle__InstanceName: "gateway-a",
        Redis__Endpoint: redisEndpoint,
        Redis__InstancePrefix: "cormier:kotlin-ktor-tests",
        Realtime__SessionSource: "Cookie",
        Realtime__AllowedOrigins__0: frontendOrigin,
      },
    },
    {
      command: "./gradlew --no-daemon run",
      cwd: resolve(repositoryRoot, "examples/kotlin-ktor"),
      url: `${frontendOrigin}/health`,
      timeout: 120_000,
      reuseExistingServer: process.env.REFERENCE_REUSE_SERVER === "true",
      env: {
        LISTEN_HOST: "127.0.0.1",
        PORT: "15300",
        PUBLIC_ORIGIN: frontendOrigin,
        GATEWAY_URL: gatewayOrigin,
        REDIS_URL: `redis://${redisEndpoint}`,
        SESSION_LIFETIME_SECONDS: "1200",
        HEARTBEAT_INTERVAL_MILLISECONDS: "5000",
        INSTANCE_NAME: "kotlin-ktor-a",
        TOPOLOGY: "non-ha",
        REDIS_INSTANCE_PREFIX: "cormier:kotlin-ktor-tests",
        REDIS_SESSION_KEY_PREFIX: "sessions",
        ALLOWED_TENANTS: "tenant-a,tenant-b",
        ALLOWED_USERS: "user-a,user-b",
        SHARED_ASSET_ROOT: resolve(repositoryRoot, "examples/shared-web/dist/optimized"),
        SDK_ASSET_ROOT: resolve(repositoryRoot, "sdk/typescript/dist"),
      },
    },
  ],
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
