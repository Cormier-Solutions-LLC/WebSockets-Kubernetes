import test from "node:test";
import assert from "node:assert/strict";
import { PROTOCOL_VERSION, RealtimeClient } from "../dist/cormier-realtime.js";

function httpHarness() {
  const messages = [];
  const requests = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    requests.push({ url, init });
    if (url.pathname.endsWith("/connect")) {
      return Response.json({ connectionId: "connection-a", connectionToken: "token-a" });
    }
    if (url.pathname.endsWith("/poll")) {
      while (messages.length === 0) {
        if (init.signal?.aborted) throw init.signal.reason;
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      return new Response(messages.shift(), { headers: { "Content-Type": "application/json" } });
    }
    if (url.pathname.endsWith("/messages")) {
      const command = JSON.parse(init.body);
      messages.push(JSON.stringify({
        version: PROTOCOL_VERSION,
        type: "ack",
        correlationId: command.correlationId,
        timestamp: new Date().toISOString(),
        route: command.route,
      }));
      return new Response(null, { status: 202 });
    }
    return new Response(null, { status: 204 });
  };
  return { fetch, requests };
}

test("HTTP streaming can be the primary transport", async () => {
  const harness = httpHarness();
  const client = new RealtimeClient({
    url: "https://gateway.example/realtime/ws",
    transports: ["http-streaming"],
    httpStreaming: { url: "https://gateway.example/realtime/http", fetch: harness.fetch },
    heartbeatIntervalMilliseconds: 60_000,
  });
  await client.connect();
  assert.equal(client.activeTransport, "http-streaming");
  await client.publish("topics/orders", { value: 42 });
  assert.equal(harness.requests.filter(({ url }) => url.pathname.endsWith("/messages")).length, 1);
  await client.disconnect();
});

test("initial WebSocket failure falls through to HTTP streaming", async () => {
  const harness = httpHarness();
  const client = new RealtimeClient({
    url: "https://gateway.example/realtime/ws",
    transports: ["websocket", "http-streaming"],
    webSocketFactory: () => { throw new Error("disabled for test"); },
    httpStreaming: { url: "https://gateway.example/realtime/http", fetch: harness.fetch },
    heartbeatIntervalMilliseconds: 60_000,
  });
  await client.connect();
  assert.equal(client.activeTransport, "http-streaming");
  await client.disconnect();
});

test("HTTP streaming selection requires explicit endpoint configuration", () => {
  assert.throws(
    () => new RealtimeClient({ url: "https://gateway.example/realtime/ws", transports: ["http-streaming"] }),
    /httpStreaming is required/,
  );
});
