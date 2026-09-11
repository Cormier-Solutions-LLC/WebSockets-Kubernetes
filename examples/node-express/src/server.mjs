import http from "node:http";
import httpProxy from "http-proxy";
import { createClient } from "redis";
import { createApp } from "./app.mjs";
import { loadConfig } from "./config.mjs";
import { connectWithDeadline, createShutdown } from "./lifecycle.mjs";
import { createRedisOptions } from "./redis.mjs";
import { createUpgradeHandler } from "./upgrade.mjs";

const config = loadConfig();
const redisClient = createClient(createRedisOptions(config.redisUrl));
redisClient.on("error", (error) => console.error(JSON.stringify({ event: "redis_error", error: error.name })));
try {
  await connectWithDeadline(redisClient, 15_000);
} catch (error) {
  console.error(JSON.stringify({ event: "startup_failed", error: error?.name ?? "Error" }));
  if (redisClient.isOpen) redisClient.destroy();
  process.exit(1);
}

const proxy = httpProxy.createProxyServer({ ws: true, xfwd: true });
proxy.on("error", (error, _request, response) => {
  console.error(JSON.stringify({ event: "gateway_proxy_error", error: error.name }));
  if (response && "writeHead" in response && !response.headersSent) {
    response.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ code: "gateway_unavailable", message: "The realtime gateway is unavailable." }));
  } else {
    response?.destroy?.();
  }
});

const app = createApp({ config, redisClient, proxy });
const server = http.createServer(app);
const upgradedSockets = new Set();
server.on("upgrade", createUpgradeHandler({
  publicOrigin: config.publicOrigin,
  publicScheme: config.publicScheme,
  gatewayUrl: config.gatewayUrl,
  proxy,
  upgradedSockets,
}));

await new Promise((resolve) => server.listen(config.port, config.listenHost, resolve));
console.log(JSON.stringify({ event: "started", stack: "node-express", instance: config.instanceName }));

const stop = createShutdown({
  server,
  proxy,
  redisClient,
  upgradedSockets,
  log: entry => console.log(JSON.stringify(entry)),
  forceExit: code => process.exit(code),
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => void stop(signal));
}
