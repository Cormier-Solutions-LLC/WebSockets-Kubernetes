import { createServer } from "node:http";

const port = Number.parseInt(process.env.REALTIME_BROWSER_STATIC_PORT ?? "14173", 10);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
  throw new RangeError("REALTIME_BROWSER_STATIC_PORT must be between 1024 and 65535.");
}

const server = createServer((request, response) => {
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  if (request.url === "/health") {
    response.writeHead(200);
    response.end("healthy");
    return;
  }
  response.writeHead(404);
  response.end("not found");
});

server.listen(port, "127.0.0.1");
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
