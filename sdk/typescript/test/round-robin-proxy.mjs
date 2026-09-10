import { createServer, request as createRequest } from "node:http";
import { connect as connectTcp } from "node:net";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const port = Number.parseInt(process.env.REALTIME_BROWSER_PROXY_PORT ?? "18083", 10);
const backends = (process.env.REALTIME_BROWSER_BACKENDS ?? "http://127.0.0.1:18081,http://127.0.0.1:18082")
  .split(",")
  .map((entry) => new URL(entry));
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535 || backends.length < 2) {
  throw new Error("A valid proxy port and at least two backend URLs are required.");
}

const activeSockets = new Set();
const stats = { httpRequests: 0, ticketRequests: 0, websocketBackends: [] };
let httpIndex = 0;
let websocketIndex = 0;
const testRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const staticFiles = new Map([
  ["/examples/browser/index.html", ["text/html; charset=utf-8", readFileSync(resolve(testRoot, "examples/browser/index.html"))]],
  ["/examples/browser/realtime-example.js", ["text/javascript; charset=utf-8", readFileSync(resolve(testRoot, "examples/browser/realtime-example.js"))]],
  ["/sdk/typescript/dist/cormier-realtime.iife.min.js", ["text/javascript; charset=utf-8", readFileSync(resolve(testRoot, "sdk/typescript/dist/cormier-realtime.iife.min.js"))]],
]);

const server = createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    response.end("healthy");
    return;
  }
  if (request.url === "/test/stats") {
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    response.end(JSON.stringify(stats));
    return;
  }
  if (request.url === "/test/drop" && request.method === "POST") {
    for (const socket of activeSockets) {
      socket.destroy();
    }
    response.writeHead(204);
    response.end();
    return;
  }
  const staticFile = staticFiles.get(request.url ?? "");
  if (staticFile !== undefined && request.method === "GET") {
    response.writeHead(200, { "Content-Type": staticFile[0], "Cache-Control": "no-store" });
    response.end(staticFile[1]);
    return;
  }
  stats.httpRequests += 1;
  if (request.url?.startsWith("/realtime/tickets")) {
    stats.ticketRequests += 1;
  }
  const target = backends[httpIndex++ % backends.length];
  const upstream = createRequest({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port,
    method: request.method,
    path: request.url,
    headers: request.headers,
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on("error", () => {
    if (!response.headersSent) {
      response.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    }
    response.end("backend unavailable");
  });
  request.pipe(upstream);
});

server.on("connection", (socket) => {
  // The reconnect test deliberately resets proxied connections. Consume the
  // resulting socket error so one expected reset cannot terminate the proxy.
  socket.on("error", (error) => {
    if (error.code !== "ECONNRESET" && error.code !== "EPIPE") {
      console.error("Proxy client socket failed.", error);
    }
  });
});

server.on("upgrade", (request, socket, head) => {
  const target = backends[websocketIndex++ % backends.length];
  stats.websocketBackends.push(target.port);
  activeSockets.add(socket);
  socket.once("close", () => activeSockets.delete(socket));
  const upstream = connectTcp(Number.parseInt(target.port, 10), target.hostname, () => {
    const headers = Object.entries(request.headers)
      .flatMap(([name, value]) => Array.isArray(value)
        ? value.map((item) => `${name}: ${item}`)
        : [`${name}: ${value ?? ""}`])
      .join("\r\n");
    upstream.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n${headers}\r\n\r\n`);
    if (head.length > 0) {
      upstream.write(head);
    }
    socket.pipe(upstream).pipe(socket);
  });
  activeSockets.add(upstream);
  upstream.once("close", () => activeSockets.delete(upstream));
  upstream.on("error", () => socket.destroy());
});

server.listen(port, "127.0.0.1");
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    for (const socket of activeSockets) {
      socket.destroy();
    }
    server.close(() => process.exit(0));
  });
}
