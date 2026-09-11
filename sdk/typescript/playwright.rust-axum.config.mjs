import { defineConfig } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const redisEndpoint = process.env.REDIS_TEST_ENDPOINT ?? "127.0.0.1:6379";
const frontendOrigin = "http://127.0.0.1:15400";
const gatewayOrigin = "http://127.0.0.1:15401";
process.env.REFERENCE_STACK = "Rust / Axum";
process.env.REFERENCE_BASE_URL = frontendOrigin;

export default defineConfig({
  testDir: "./test/reference-adapters",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  workers: 1,
  fullyParallel: false,
  reporter: process.env.CI ? [["line"], ["html", { outputFolder: "../../artifacts/rust-axum/playwright-report", open: "never" }]] : "line",
  outputDir: "../../artifacts/rust-axum/test-results",
  use: { baseURL: frontendOrigin, trace: "retain-on-failure", screenshot: "only-on-failure", video: "retain-on-failure" },
  webServer: [
    {
      command: "dotnet run --project examples/full-circle/Cormier.Realtime.Example.FullCircle.csproj --configuration Release --no-build --no-restore",
      cwd: repositoryRoot,
      url: `${gatewayOrigin}/health`,
      timeout: 60_000,
      reuseExistingServer: false,
      env: {
        ASPNETCORE_URLS: gatewayOrigin,
        FullCircle__Topology: "non-ha",
        FullCircle__InstanceName: "gateway-a",
        Redis__Endpoint: redisEndpoint,
        Redis__InstancePrefix: "cormier:rust-axum-tests",
        Realtime__SessionSource: "Cookie",
        Realtime__AllowedOrigins__0: frontendOrigin,
      },
    },
    {
      command: "cargo run --locked",
      cwd: resolve(repositoryRoot, "examples/rust-axum"),
      url: `${frontendOrigin}/health`,
      timeout: 120_000,
      reuseExistingServer: process.env.REFERENCE_REUSE_SERVER === "true",
      env: {
        PORT: "15400", PUBLIC_ORIGIN: frontendOrigin, GATEWAY_URL: gatewayOrigin,
        REDIS_URL: `redis://${redisEndpoint}`, SESSION_LIFETIME_SECONDS: "1200",
        INSTANCE_NAME: "rust-axum-a", TOPOLOGY: "non-ha",
        REDIS_INSTANCE_PREFIX: "cormier:rust-axum-tests", REDIS_SESSION_KEY_PREFIX: "sessions",
        ALLOWED_TENANTS: "tenant-a,tenant-b", ALLOWED_USERS: "user-a,user-b",
        SHARED_ASSET_ROOT: resolve(repositoryRoot, "examples/shared-web/wwwroot"),
        SDK_ASSET_ROOT: resolve(repositoryRoot, "sdk/typescript/dist"),
      },
    },
  ],
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
