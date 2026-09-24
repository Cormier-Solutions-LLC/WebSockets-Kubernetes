import { defineConfig } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const redisEndpoint = process.env.REDIS_TEST_ENDPOINT ?? "127.0.0.1:6379";
const frontendOrigin = "http://127.0.0.1:15500";
const gatewayOrigin = "http://127.0.0.1:15501";
const gatewayListenOrigin = "http://0.0.0.0:15501";
const image = process.env.PYTHON_FASTAPI_IMAGE ?? "cormier-python-fastapi:local";
process.env.REFERENCE_STACK = "Python / FastAPI";
process.env.REFERENCE_BASE_URL = frontendOrigin;
process.env.REFERENCE_GATEWAY_URL = gatewayOrigin;

export default defineConfig({
  testDir: "./test/reference-adapters",
  globalTeardown: "./test/reference-adapters/stop-python-fastapi-container.mjs",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  workers: 1,
  fullyParallel: false,
  reporter: process.env.CI ? [["line"], ["html", { outputFolder: "../../artifacts/python-fastapi/playwright-report", open: "never" }]] : "line",
  outputDir: "../../artifacts/python-fastapi/test-results",
  use: { baseURL: frontendOrigin, trace: "retain-on-failure", screenshot: "only-on-failure", video: "retain-on-failure" },
  webServer: [
    {
      command: "dotnet run --project examples/full-circle/Cormier.Realtime.Example.FullCircle.csproj --configuration Release --no-build --no-restore",
      cwd: repositoryRoot,
      url: `${gatewayOrigin}/health`,
      timeout: 60_000,
      reuseExistingServer: false,
      env: {
        ASPNETCORE_ENVIRONMENT: "Automation",
        ASPNETCORE_URLS: gatewayListenOrigin,
        FullCircle__Topology: "non-ha",
        FullCircle__InstanceName: "gateway-a",
        Redis__Endpoint: redisEndpoint,
        Redis__InstancePrefix: "cormier:python-fastapi-tests",
        Realtime__SessionSource: "Cookie",
        Realtime__AllowedOrigins__0: frontendOrigin,
      },
    },
    {
      command: `docker run --rm --name cormier-python-fastapi-playwright --add-host host.docker.internal:host-gateway -p 127.0.0.1:15500:15500 -e LISTEN_HOST=0.0.0.0 -e PORT=15500 -e PUBLIC_ORIGIN=${frontendOrigin} -e GATEWAY_URL=http://host.docker.internal:15501 -e REDIS_URL=redis://host.docker.internal:${redisEndpoint.split(":").at(-1)} -e SESSION_LIFETIME_SECONDS=1200 -e INSTANCE_NAME=python-fastapi-a -e TOPOLOGY=non-ha -e REDIS_INSTANCE_PREFIX=cormier:python-fastapi-tests -e REDIS_SESSION_KEY_PREFIX=sessions -e ALLOWED_TENANTS=tenant-a,tenant-b -e ALLOWED_USERS=user-a,user-b ${image}`,
      cwd: repositoryRoot,
      url: `${frontendOrigin}/health`,
      timeout: 120_000,
      reuseExistingServer: process.env.REFERENCE_REUSE_SERVER === "true",
    },
  ],
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
