import test from "node:test";
import assert from "node:assert/strict";
import {
  PROTOCOL_VERSION,
  RealtimeClient,
  RealtimeError,
  RealtimeQueueError,
  WEBSOCKET_SUBPROTOCOL,
} from "../dist/cormier-realtime.js";

class FakeSocket {
  readyState = 0;
  binaryType = "blob";
  onopen = null;
  onmessage = null;
  onerror = null;
  onclose = null;
  sent = [];
  protocol;
  url;

  constructor(url, protocol, automaticallyOpen = true) {
    this.url = url;
    this.protocol = protocol;
    if (automaticallyOpen) {
      queueMicrotask(() => this.serverOpen());
    }
  }

  send(data) {
    if (this.readyState !== 1) {
      throw new Error("socket is not open");
    }
    this.sent.push(data);
  }

  close(code = 1000, reason = "") {
    if (this.readyState >= 2) {
      return;
    }
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.({ code, reason, wasClean: true }));
  }

  serverOpen() {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }

  serverMessage(envelope) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(envelope) }));
  }

  serverClose(code = 1006, reason = "network_interruption") {
    this.readyState = 3;
    this.onclose?.({ code, reason, wasClean: false });
  }
}

function acknowledgement(command) {
  return {
    version: PROTOCOL_VERSION,
    type: "ack",
    correlationId: command.correlationId,
    timestamp: new Date().toISOString(),
    route: command.route,
  };
}

async function waitUntil(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(message);
}

test("ticket authentication connects without surfacing credential material", async () => {
  const sockets = [];
  const ticket = "test-ticket-material-12345678901234567890";
  const client = new RealtimeClient({
    url: "https://gateway.example/realtime/ws",
    authentication: {
      kind: "ticket",
      fetch: async () => new Response(JSON.stringify({ ticket, expiresAt: new Date(Date.now() + 30_000).toISOString() }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    },
    webSocketFactory: (url, protocol) => {
      const socket = new FakeSocket(url, protocol);
      sockets.push(socket);
      return socket;
    },
    heartbeatIntervalMilliseconds: 60_000,
  });

  await client.connect();
  assert.equal(client.state, "open");
  assert.equal(sockets[0].protocol, WEBSOCKET_SUBPROTOCOL);
  assert.equal(new URL(sockets[0].url).protocol, "wss:");
  assert.equal(new URL(sockets[0].url).searchParams.get("ticket"), ticket);
  await client.disconnect();
});

test("subscriptions are unique, dispatch events, and unsubscribe once", async () => {
  let socket;
  const client = new RealtimeClient({
    url: "ws://gateway.example/realtime/ws",
    webSocketFactory: (url, protocol) => (socket = new FakeSocket(url, protocol)),
    heartbeatIntervalMilliseconds: 60_000,
  });
  await client.connect();

  const firstEvents = [];
  const firstSubscription = client.subscribe("topics/orders", (event) => firstEvents.push(event));
  await waitUntil(() => socket.sent.length === 1, "subscribe command was not sent");
  const subscribe = JSON.parse(socket.sent[0]);
  socket.serverMessage(acknowledgement(subscribe));
  const unsubscribeFirst = await firstSubscription;
  const unsubscribeSecond = await client.subscribe("topics/orders", () => undefined);
  assert.equal(socket.sent.length, 1, "duplicate listener sent a duplicate subscription");

  const event = {
    version: PROTOCOL_VERSION,
    type: "event",
    correlationId: "event-1",
    timestamp: new Date().toISOString(),
    route: "topics/orders",
    payload: { value: 42 },
  };
  socket.serverMessage(event);
  assert.deepEqual(firstEvents, [event]);
  await unsubscribeFirst();
  const finalUnsubscribe = unsubscribeSecond();
  await waitUntil(() => socket.sent.length === 2, "unsubscribe command was not sent");
  const unsubscribe = JSON.parse(socket.sent[1]);
  socket.serverMessage(acknowledgement(unsubscribe));
  await finalUnsubscribe;
  assert.deepEqual(client.desiredSubscriptions, []);
  await client.disconnect();
});

test("reconnect uses a fresh ticket and restores each intended subscription once", async () => {
  const sockets = [];
  let ticketRequests = 0;
  const client = new RealtimeClient({
    url: "wss://gateway.example/realtime/ws",
    authentication: {
      kind: "ticket",
      fetch: async () => {
        ticketRequests += 1;
        return new Response(JSON.stringify({
          ticket: `test-ticket-${ticketRequests.toString().padStart(32, "0")}`,
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    },
    reconnect: { initialDelayMilliseconds: 1, maximumDelayMilliseconds: 2, jitterRatio: 0, maximumAttempts: 3 },
    random: () => 0.5,
    heartbeatIntervalMilliseconds: 60_000,
    webSocketFactory: (url, protocol) => {
      const socket = new FakeSocket(url, protocol);
      sockets.push(socket);
      return socket;
    },
  });
  await client.connect();
  const subscription = client.subscribe("topics/orders", () => undefined);
  await waitUntil(() => sockets[0].sent.length === 1, "initial subscription was not sent");
  sockets[0].serverMessage(acknowledgement(JSON.parse(sockets[0].sent[0])));
  await subscription;

  sockets[0].serverMessage({
    version: PROTOCOL_VERSION,
    type: "service.restart",
    correlationId: "restart-1",
    timestamp: new Date().toISOString(),
    route: "system/restart",
    reconnect: { initialDelayMilliseconds: 1, maximumDelayMilliseconds: 2, jitterRatio: 0, reauthenticate: true },
  });
  sockets[0].serverClose(1012, "service_restart");
  await waitUntil(() => sockets.length === 2 && sockets[1].sent.length === 1, "subscription was not restored");
  assert.equal(ticketRequests, 2);
  assert.equal(JSON.parse(sockets[1].sent[0]).type, "subscribe");
  assert.equal(sockets[1].sent.length, 1);
  sockets[1].serverMessage(acknowledgement(JSON.parse(sockets[1].sent[0])));
  await client.disconnect();
});

test("temporary ticket-service interruption retries without corrupting subscription state", async () => {
  const sockets = [];
  let ticketRequests = 0;
  const client = new RealtimeClient({
    url: "wss://gateway.example/realtime/ws",
    authentication: {
      kind: "ticket",
      fetch: async () => {
        ticketRequests += 1;
        if (ticketRequests === 2) {
          return new Response("unavailable", { status: 503 });
        }
        return new Response(JSON.stringify({
          ticket: `recovery-ticket-${ticketRequests.toString().padStart(32, "0")}`,
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    },
    reconnect: { initialDelayMilliseconds: 1, maximumDelayMilliseconds: 2, jitterRatio: 0, maximumAttempts: 4 },
    heartbeatIntervalMilliseconds: 60_000,
    webSocketFactory: (url, protocol) => {
      const socket = new FakeSocket(url, protocol);
      sockets.push(socket);
      return socket;
    },
  });
  await client.connect();
  const subscription = client.subscribe("topics/orders", () => undefined);
  await waitUntil(() => sockets[0].sent.length === 1, "initial subscription was not sent");
  sockets[0].serverMessage(acknowledgement(JSON.parse(sockets[0].sent[0])));
  await subscription;
  sockets[0].serverClose();
  await waitUntil(() => ticketRequests === 3 && sockets.length === 2 && sockets[1].sent.length === 1, "recovery did not restore the subscription");
  assert.deepEqual(client.desiredSubscriptions, ["topics/orders"]);
  assert.equal(JSON.parse(sockets[1].sent[0]).type, "subscribe");
  sockets[1].serverMessage(acknowledgement(JSON.parse(sockets[1].sent[0])));
  await client.disconnect();
});

test("bounded command queue rejects saturation", async () => {
  const client = new RealtimeClient({
    url: "ws://gateway.example/realtime/ws",
    maximumQueuedCommands: 1,
    webSocketFactory: (url, protocol) => new FakeSocket(url, protocol, false),
  });
  const first = client.publish("topics/orders", { value: 1 });
  await assert.rejects(client.publish("topics/orders", { value: 2 }), RealtimeQueueError);
  await client.disconnect();
  await assert.rejects(first, /disconnected/i);
});

test("an initial connection failure rejects every queued command", async () => {
  let rejectTicketRequest;
  const ticketRequest = new Promise((_, reject) => {
    rejectTicketRequest = reject;
  });
  const client = new RealtimeClient({
    url: "wss://gateway.example/realtime/ws",
    authentication: { kind: "ticket", fetch: () => ticketRequest },
  });
  const first = client.publish("topics/orders", { value: 1 });
  const second = client.publish("topics/orders", { value: 2 });
  rejectTicketRequest(new Error("ticket service unavailable"));
  await assert.rejects(first, /ticket service unavailable/i);
  await assert.rejects(second, /ticket service unavailable/i);
  assert.equal(client.state, "closed");
});

test("an explicit connection failure leaves the client closed", async () => {
  const client = new RealtimeClient({
    url: "wss://gateway.example/realtime/ws",
    authentication: {
      kind: "ticket",
      fetch: async () => new Response("unavailable", { status: 503 }),
    },
  });
  await assert.rejects(client.connect(), /ticket request failed \(503\)/i);
  assert.equal(client.state, "closed");
});

test("queued and in-flight commands observe cancellation immediately", async () => {
  let socket;
  const client = new RealtimeClient({
    url: "ws://gateway.example/realtime/ws",
    webSocketFactory: (url, protocol) => (socket = new FakeSocket(url, protocol, false)),
    commandTimeoutMilliseconds: 60_000,
  });
  const queuedCancellation = new AbortController();
  const queued = client.publish("topics/orders", { value: 1 }, queuedCancellation.signal);
  queuedCancellation.abort();
  await assert.rejects(queued, { name: "AbortError" });

  socket.serverOpen();
  await client.connect();
  const pendingCancellation = new AbortController();
  const pending = client.publish("topics/orders", { value: 2 }, pendingCancellation.signal);
  await waitUntil(() => socket.sent.length === 1, "publish command was not sent");
  pendingCancellation.abort();
  await assert.rejects(pending, { name: "AbortError" });
  await client.disconnect();
});

test("oversized commands and cancelled operations fail before transport", async () => {
  let socket;
  const client = new RealtimeClient({
    url: "ws://gateway.example/realtime/ws",
    maximumMessageBytes: 256,
    webSocketFactory: (url, protocol) => (socket = new FakeSocket(url, protocol)),
    heartbeatIntervalMilliseconds: 60_000,
  });
  await client.connect();
  await assert.rejects(
    client.publish("topics/orders", { value: "x".repeat(512) }),
    (error) => error instanceof RealtimeError && error.code === "message_too_large",
  );
  const cancellation = new AbortController();
  cancellation.abort();
  await assert.rejects(client.publish("topics/orders", { value: 1 }, cancellation.signal), { name: "AbortError" });
  assert.equal(socket.sent.length, 0);
  await client.disconnect();
});

test("structured server errors reject only the correlated command", async () => {
  let socket;
  const client = new RealtimeClient({
    url: "ws://gateway.example/realtime/ws",
    webSocketFactory: (url, protocol) => (socket = new FakeSocket(url, protocol)),
    heartbeatIntervalMilliseconds: 60_000,
  });
  await client.connect();
  const publish = client.publish("topics/orders", { value: 42 });
  await waitUntil(() => socket.sent.length === 1, "publish command was not sent");
  const command = JSON.parse(socket.sent[0]);
  socket.serverMessage({
    ...acknowledgement(command),
    type: "error",
    error: { code: "unauthorized", message: "Not authorized." },
  });
  await assert.rejects(publish, (error) => error instanceof RealtimeError && error.code === "unauthorized");
  await client.disconnect();
});

test("heartbeat traffic keeps an otherwise idle client active", async () => {
  let socket;
  const client = new RealtimeClient({
    url: "ws://gateway.example/realtime/ws",
    webSocketFactory: (url, protocol) => {
      socket = new FakeSocket(url, protocol);
      const originalSend = socket.send.bind(socket);
      socket.send = (data) => {
        originalSend(data);
        const command = JSON.parse(data);
        queueMicrotask(() => socket.serverMessage(acknowledgement(command)));
      };
      return socket;
    },
    heartbeatIntervalMilliseconds: 5,
  });
  await client.connect();
  await waitUntil(() => socket.sent.length >= 2, "heartbeat commands were not sent");
  assert.equal(client.state, "open");
  assert.ok(socket.sent.every((item) => JSON.parse(item).type === "ping"));
  await client.disconnect();
});

test("malformed server traffic is isolated as a structured client error", async () => {
  let socket;
  const errors = [];
  const client = new RealtimeClient({
    url: "ws://gateway.example/realtime/ws",
    webSocketFactory: (url, protocol) => (socket = new FakeSocket(url, protocol)),
    heartbeatIntervalMilliseconds: 60_000,
  });
  client.on("error", (error) => errors.push(error));
  await client.connect();
  socket.onmessage(new MessageEvent("message", { data: "{not-json" }));
  assert.equal(errors[0].code, "invalid_envelope");
  assert.equal(client.state, "open");
  await client.disconnect();
});
