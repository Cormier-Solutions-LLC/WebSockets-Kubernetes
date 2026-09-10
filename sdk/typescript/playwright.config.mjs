import { defineConfig } from "@playwright/test";

const gatewayPort = Number.parseInt(process.env.REALTIME_BROWSER_GATEWAY_PORT ?? "18081", 10);
const secondGatewayPort = Number.parseInt(process.env.REALTIME_BROWSER_SECOND_GATEWAY_PORT ?? "18082", 10);
const proxyPort = Number.parseInt(process.env.REALTIME_BROWSER_PROXY_PORT ?? "18083", 10);
const staticPort = Number.parseInt(process.env.REALTIME_BROWSER_STATIC_PORT ?? "14173", 10);
const redisEndpoint = process.env.REDIS_TEST_ENDPOINT ?? "127.0.0.1:6379";

export default defineConfig({
  testDir: "./test/browser",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "line",
  use: {
    baseURL: `http://127.0.0.1:${proxyPort}`,
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "dotnet run --project ../../src/Cormier.Realtime.Gateway --configuration Release --no-launch-profile --no-build --no-restore",
      url: `http://127.0.0.1:${gatewayPort}/health/live`,
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
      env: {
        ASPNETCORE_URLS: `http://127.0.0.1:${gatewayPort}`,
        Gateway__ShutdownDrainSeconds: "1",
        Redis__Endpoint: redisEndpoint,
        Redis__InstancePrefix: "cormier:browser-tests",
        Redis__RequiredForReadiness: "true",
        Realtime__AllowedOrigins__0: `http://127.0.0.1:${proxyPort}`,
        Realtime__AllowedOrigins__1: `http://127.0.0.1:${gatewayPort}`,
        Realtime__HeartbeatSeconds: "5",
        Realtime__IdleTimeoutSeconds: "15",
      },
    },
    {
      command: "dotnet run --project ../../src/Cormier.Realtime.Gateway --configuration Release --no-launch-profile --no-build --no-restore",
      url: `http://127.0.0.1:${secondGatewayPort}/health/live`,
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
      env: {
        ASPNETCORE_URLS: `http://127.0.0.1:${secondGatewayPort}`,
        Gateway__ServiceName: "cormier-realtime-browser-b",
        Gateway__ShutdownDrainSeconds: "1",
        Redis__Endpoint: redisEndpoint,
        Redis__InstancePrefix: "cormier:browser-tests",
        Redis__RequiredForReadiness: "true",
        Realtime__AllowedOrigins__0: `http://127.0.0.1:${proxyPort}`,
        Realtime__AllowedOrigins__1: `http://127.0.0.1:${secondGatewayPort}`,
        Realtime__HeartbeatSeconds: "5",
        Realtime__IdleTimeoutSeconds: "15",
      },
    },
    {
      command: "node ./test/round-robin-proxy.mjs",
      url: `http://127.0.0.1:${proxyPort}/health`,
      timeout: 30_000,
      reuseExistingServer: !process.env.CI,
      env: {
        REALTIME_BROWSER_PROXY_PORT: String(proxyPort),
        REALTIME_BROWSER_BACKENDS: `http://127.0.0.1:${gatewayPort},http://127.0.0.1:${secondGatewayPort}`,
      },
    },
    {
      command: "node ./test/static-server.mjs",
      url: `http://127.0.0.1:${staticPort}/health`,
      timeout: 30_000,
      reuseExistingServer: !process.env.CI,
      env: { REALTIME_BROWSER_STATIC_PORT: String(staticPort) },
    },
  ],
  globalSetup: "./test/browser/global-setup.mjs",
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "firefox", use: { browserName: "firefox" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
});
