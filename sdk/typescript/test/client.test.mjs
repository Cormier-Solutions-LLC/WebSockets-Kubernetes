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
  let ticketEndpoint;
  const client = new RealtimeClient({
    url: "https://gateway.example/realtime/ws",
    authentication: {
      kind: "ticket",
      fetch: async (endpoint) => {
        ticketEndpoint = endpoint;
        return new Response(JSON.stringify({ ticket, expiresAt: new Date(Date.now() + 30_000).toISOString() }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
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
  assert.equal(ticketEndpoint.toString(), "https://gateway.example/realtime/tickets");
  assert.equal(sockets[0].protocol, WEBSOCKET_SUBPROTOCOL);
  assert.equal(new URL(sockets[0].url).protocol, "wss:");
  assert.equal(new URL(sockets[0].url).searchParams.get("ticket"), ticket);
  await client.disconnect();
});

test("reserved reconnect context cannot be supplied by callers", () => {
  assert.throws(
    () => new RealtimeClient({ url: "wss://gateway.example/realtime/ws?reconnect=true" }),
    /reserved reconnect query parameter/,
  );
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

test("identical listener function registrations remain independent", async () => {
  let socket;
  let deliveries = 0;
  const listener = () => { deliveries += 1; };
  const client = new RealtimeClient({
    url: "ws://gateway.example/realtime/ws",
    webSocketFactory: (url, protocol) => (socket = new FakeSocket(url, protocol)),
    heartbeatIntervalMilliseconds: 60_000,
  });
  await client.connect();
  const first = client.subscribe("topics/orders", listener);
  const second = client.subscribe("topics/orders", listener);
  await waitUntil(() => socket.sent.length === 1, "subscribe command was not sent");
  socket.serverMessage(acknowledgement(JSON.parse(socket.sent[0])));
  const unsubscribeFirst = await first;
  const unsubscribeSecond = await second;
  const event = {
    version: PROTOCOL_VERSION,
    type: "event",
    correlationId: "same-listener-event",
    timestamp: new Date().toISOString(),
    route: "topics/orders",
    payload: { value: 42 },
  };
  socket.serverMessage(event);
  assert.equal(deliveries, 2);
  await unsubscribeFirst();
  assert.equal(socket.sent.length, 1);
  socket.serverMessage(event);
  assert.equal(deliveries, 3);
  const finalUnsubscribe = unsubscribeSecond();
  await waitUntil(() => socket.sent.length === 2, "unsubscribe command was not sent");
  socket.serverMessage(acknowledgement(JSON.parse(socket.sent[1])));
  await finalUnsubscribe;
  await client.disconnect();
});

test("a failed final unsubscribe retains a retryable desired subscription", async () => {
  const sockets = [];
  const client = new RealtimeClient({
    url: "ws://gateway.example/realtime/ws",
    reconnect: { enabled: false },
    webSocketFactory: (url, protocol) => {
      const socket = new FakeSocket(url, protocol);
      sockets.push(socket);
      return socket;
    },
    heartbeatIntervalMilliseconds: 60_000,
  });
  await client.connect();
  const subscription = client.subscribe("topics/orders", () => undefined);
  await waitUntil(() => sockets[0].sent.length === 1, "subscribe command was not sent");
  sockets[0].serverMessage(acknowledgement(JSON.parse(sockets[0].sent[0])));
  const unsubscribe = await subscription;
  const failedUnsubscribe = unsubscribe();
  await waitUntil(() => sockets[0].sent.length === 2, "unsubscribe command was not sent");
  sockets[0].serverMessage({
    ...acknowledgement(JSON.parse(sockets[0].sent[1])),
    type: "error",
    error: { code: "service_draining", message: "Try again later." },
  });
  await assert.rejects(failedUnsubscribe, (error) => error instanceof RealtimeError && error.code === "service_draining");
  await waitUntil(() => client.state === "closed", "failed unsubscribe did not reset the connection");
  assert.deepEqual(client.desiredSubscriptions, ["topics/orders"]);

  const reconnection = client.connect();
  await waitUntil(() => sockets.length === 2 && sockets[1].sent.length === 1, "subscription was not restored");
  sockets[1].serverMessage(acknowledgement(JSON.parse(sockets[1].sent[0])));
  await reconnection;
  const retry = unsubscribe();
  await waitUntil(() => sockets[1].sent.length === 2, "unsubscribe retry was not sent");
  sockets[1].serverMessage(acknowledgement(JSON.parse(sockets[1].sent[1])));
  await retry;
  assert.deepEqual(client.desiredSubscriptions, []);
  await client.disconnect();
});

test("duplicate subscribers share a failed in-flight subscription", async () => {
  let socket;
  const client = new RealtimeClient({
    url: "ws://gateway.example/realtime/ws",
    webSocketFactory: (url, protocol) => (socket = new FakeSocket(url, protocol)),
    heartbeatIntervalMilliseconds: 60_000,
  });
  await client.connect();
  const first = client.subscribe("topics/orders", () => undefined);
  const second = client.subscribe("topics/orders", () => undefined);
  await waitUntil(() => socket.sent.length === 1, "subscribe command was not sent");
  const command = JSON.parse(socket.sent[0]);
  socket.serverMessage({
    ...acknowledgement(command),
    type: "error",
    error: { code: "unauthorized", message: "Not authorized." },
  });
  await assert.rejects(first, (error) => error instanceof RealtimeError && error.code === "unauthorized");
  await assert.rejects(second, (error) => error instanceof RealtimeError && error.code === "unauthorized");
  assert.deepEqual(client.desiredSubscriptions, []);
  await client.disconnect();
});

test("duplicate subscriber cancellation is scoped to each caller", async () => {
  let socket;
  const client = new RealtimeClient({
    url: "ws://gateway.example/realtime/ws",
    webSocketFactory: (url, protocol) => (socket = new FakeSocket(url, protocol)),
    heartbeatIntervalMilliseconds: 60_000,
  });
  await client.connect();
  const firstCancellation = new AbortController();
  const secondCancellation = new AbortController();
  const first = client.subscribe("topics/orders", () => undefined, firstCancellation.signal);
  const second = client.subscribe("topics/orders", () => undefined, secondCancellation.signal);
  secondCancellation.abort();
  await assert.rejects(second, { name: "AbortError" });
  await waitUntil(() => socket.sent.length === 1, "shared subscribe command was not sent");
  socket.serverMessage(acknowledgement(JSON.parse(socket.sent[0])));
  const unsubscribe = await first;
  assert.deepEqual(client.desiredSubscriptions, ["topics/orders"]);
  const finalUnsubscribe = unsubscribe();
  await waitUntil(() => socket.sent.length === 2, "unsubscribe command was not sent");
  socket.serverMessage(acknowledgement(JSON.parse(socket.sent[1])));
  await finalUnsubscribe;
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
  assert.equal(new URL(sockets[0].url).searchParams.has("reconnect"), false);
  assert.equal(new URL(sockets[1].url).searchParams.get("reconnect"), "true");
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

test("a failed subscription restoration reconciles every route and rejects queued commands", async () => {
  const sockets = [];
  const client = new RealtimeClient({
    url: "ws://gateway.example/realtime/ws",
    reconnect: { initialDelayMilliseconds: 1, maximumDelayMilliseconds: 1, jitterRatio: 0, maximumAttempts: 2 },
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
  const secondSubscription = client.subscribe("topics/customers", () => undefined);
  await waitUntil(() => sockets[0].sent.length === 2, "second subscription was not sent");
  sockets[0].serverMessage(acknowledgement(JSON.parse(sockets[0].sent[1])));
  await secondSubscription;

  sockets[0].serverClose();
  const publish = client.publish("topics/orders", { value: 42 });
  const publishRejection = assert.rejects(
    publish,
    (error) => error instanceof RealtimeError && error.code === "subscription_restore_failed",
  );
  await waitUntil(() => sockets.length === 2 && sockets[1].sent.length === 1, "subscription restoration was not sent");
  const restoration = JSON.parse(sockets[1].sent[0]);
  sockets[1].serverMessage({
    ...acknowledgement(restoration),
    type: "error",
    error: { code: "service_draining", message: "Try again later." },
  });
  await waitUntil(() => sockets[1].sent.length === 2, "later subscription restoration was not attempted");
  const laterRestoration = JSON.parse(sockets[1].sent[1]);
  assert.equal(laterRestoration.route, "topics/customers");
  sockets[1].serverMessage(acknowledgement(laterRestoration));
  await publishRejection;
  await client.disconnect();
});

test("a closed restoration socket cannot queue commands into the next generation", async () => {
  const sockets = [];
  const client = new RealtimeClient({
    url: "ws://gateway.example/realtime/ws",
    reconnect: { initialDelayMilliseconds: 1, maximumDelayMilliseconds: 1, jitterRatio: 0, maximumAttempts: 3 },
    heartbeatIntervalMilliseconds: 60_000,
    webSocketFactory: (url, protocol) => {
      const socket = new FakeSocket(url, protocol);
      sockets.push(socket);
      return socket;
    },
  });
  await client.connect();
  for (const route of ["topics/orders", "topics/customers"]) {
    const subscription = client.subscribe(route, () => undefined);
    await waitUntil(() => sockets[0].sent.some((item) => JSON.parse(item).route === route), `subscribe for ${route} was not sent`);
    const command = sockets[0].sent.map((item) => JSON.parse(item)).find((item) => item.route === route);
    sockets[0].serverMessage(acknowledgement(command));
    await subscription;
  }
  sockets[0].serverClose();
  await waitUntil(() => sockets.length === 2 && sockets[1].sent.length === 1, "restoration did not start");
  sockets[1].serverClose();
  await waitUntil(() => sockets.length === 3 && sockets[2].sent.length === 1, "next restoration did not start");
  assert.equal(sockets[1].sent.length, 1, "closed socket attempted another restoration command");
  sockets[2].serverMessage(acknowledgement(JSON.parse(sockets[2].sent[0])));
  await waitUntil(() => sockets[2].sent.length === 2, "second route was not restored");
  sockets[2].serverMessage(acknowledgement(JSON.parse(sockets[2].sent[1])));
  await waitUntil(() => client.state === "open", "client did not recover");
  assert.equal(sockets[2].sent.length, 2, "stale restoration duplicated a subscription");
  await client.disconnect();
});

test("open is emitted only after subscriptions are restored", async () => {
  const sockets = [];
  let publishAfterOpen;
  const client = new RealtimeClient({
    url: "ws://gateway.example/realtime/ws",
    reconnect: { initialDelayMilliseconds: 1, maximumDelayMilliseconds: 1, jitterRatio: 0, maximumAttempts: 2 },
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
  client.on("state", (state) => {
    if (state === "open" && sockets.length === 2) {
      publishAfterOpen = client.publish("topics/orders", { value: 42 });
    }
  });
  sockets[0].serverClose();
  await waitUntil(() => sockets.length === 2 && sockets[1].sent.length === 1, "restoration was not sent");
  assert.equal(client.state, "reconnecting");
  assert.equal(JSON.parse(sockets[1].sent[0]).type, "subscribe");
  sockets[1].serverMessage(acknowledgement(JSON.parse(sockets[1].sent[0])));
  await waitUntil(() => sockets[1].sent.length === 2, "open listener did not publish");
  assert.equal(JSON.parse(sockets[1].sent[1]).type, "publish");
  sockets[1].serverMessage(acknowledgement(JSON.parse(sockets[1].sent[1])));
  await publishAfterOpen;
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

test("an explicit connection failure rejects commands queued behind it", async () => {
  let rejectTicketRequest;
  const ticketRequest = new Promise((_, reject) => {
    rejectTicketRequest = reject;
  });
  const client = new RealtimeClient({
    url: "wss://gateway.example/realtime/ws",
    authentication: { kind: "ticket", fetch: () => ticketRequest },
  });
  const connection = client.connect();
  const publish = client.publish("topics/orders", { value: 1 });
  rejectTicketRequest(new Error("ticket service unavailable"));
  await assert.rejects(connection, /ticket service unavailable/i);
  await assert.rejects(publish, /ticket service unavailable/i);
});

test("disconnect immediately cancels an outstanding ticket request and permits reconnect", async () => {
  const ticketRequest = new Promise(() => undefined);
  let ticketRequests = 0;
  const sockets = [];
  const client = new RealtimeClient({
    url: "wss://gateway.example/realtime/ws",
    authentication: {
      kind: "ticket",
      fetch: () => {
        ticketRequests += 1;
        return ticketRequests === 1
          ? ticketRequest
          : Promise.resolve(new Response(JSON.stringify({
            ticket: "replacement-ticket-12345678901234567890",
            expiresAt: new Date(Date.now() + 30_000).toISOString(),
          }), { status: 200, headers: { "Content-Type": "application/json" } }));
      },
    },
    webSocketFactory: (url, protocol) => {
      const socket = new FakeSocket(url, protocol);
      sockets.push(socket);
      return socket;
    },
  });
  const connection = client.connect();
  await client.disconnect();
  await assert.rejects(connection, (error) => error instanceof RealtimeError && error.code === "connection_superseded");
  assert.equal(sockets.length, 0);
  assert.equal(client.state, "closed");
  await client.connect();
  assert.equal(sockets.length, 1);
  assert.equal(client.state, "open");
  await client.disconnect();
});

test("an explicit handshake failure does not schedule an automatic reconnect", async () => {
  const sockets = [];
  const client = new RealtimeClient({
    url: "ws://gateway.example/realtime/ws",
    reconnect: { initialDelayMilliseconds: 1, maximumDelayMilliseconds: 1, jitterRatio: 0, maximumAttempts: 3 },
    webSocketFactory: (url, protocol) => {
      const socket = new FakeSocket(url, protocol, false);
      sockets.push(socket);
      return socket;
    },
  });
  const connection = client.connect();
  await waitUntil(() => sockets.length === 1, "connection socket was not created");
  sockets[0].serverClose();
  await assert.rejects(connection, /closed during connection/i);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sockets.length, 1);
  assert.equal(client.state, "closed");
});

test("close listeners observe closed state and can reconnect manually", async () => {
  const sockets = [];
  let manualConnection;
  const client = new RealtimeClient({
    url: "ws://gateway.example/realtime/ws",
    reconnect: { enabled: false },
    webSocketFactory: (url, protocol) => {
      const socket = new FakeSocket(url, protocol);
      sockets.push(socket);
      return socket;
    },
    heartbeatIntervalMilliseconds: 60_000,
  });
  await client.connect();
  client.on("close", () => {
    assert.equal(client.state, "closed");
    manualConnection = client.connect();
  });
  sockets[0].serverClose();
  await waitUntil(() => sockets.length === 2, "close listener did not reconnect");
  await manualConnection;
  assert.equal(client.state, "open");
  await client.disconnect();
});

test("a manual connection supersedes an in-flight automatic reconnect", async () => {
  let resolveReconnectTicket;
  const reconnectTicket = new Promise((resolve) => {
    resolveReconnectTicket = resolve;
  });
  let ticketRequest = 0;
  const sockets = [];
  const ticketResponse = (name) => new Response(JSON.stringify({
    ticket: `${name}-ticket-123456789012345678901234567890`,
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
  }), { status: 200, headers: { "Content-Type": "application/json" } });
  const client = new RealtimeClient({
    url: "wss://gateway.example/realtime/ws",
    authentication: {
      kind: "ticket",
      fetch: async () => {
        ticketRequest += 1;
        if (ticketRequest === 2) {
          return reconnectTicket;
        }
        return ticketResponse(`request-${ticketRequest}`);
      },
    },
    reconnect: { initialDelayMilliseconds: 1, maximumDelayMilliseconds: 1, jitterRatio: 0, maximumAttempts: 2 },
    heartbeatIntervalMilliseconds: 60_000,
    webSocketFactory: (url, protocol) => {
      const socket = new FakeSocket(url, protocol, sockets.length === 0);
      sockets.push(socket);
      return socket;
    },
  });
  await client.connect();
  sockets[0].serverClose();
  await waitUntil(() => ticketRequest === 2, "automatic reconnect did not request a ticket");
  const manualConnection = client.connect();
  await waitUntil(() => sockets.length === 2, "manual connection did not create a socket");
  assert.equal(client.state, "connecting");
  resolveReconnectTicket(ticketResponse("stale-reconnect"));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sockets.length, 2);
  sockets[1].serverOpen();
  await manualConnection;
  assert.equal(client.state, "open");
  assert.equal(sockets.length, 2, "superseded reconnect opened another socket");
  await client.disconnect();
});

test("a synchronous send failure closes the broken socket and reconnects", async () => {
  const sockets = [];
  const client = new RealtimeClient({
    url: "ws://gateway.example/realtime/ws",
    reconnect: { initialDelayMilliseconds: 1, maximumDelayMilliseconds: 1, jitterRatio: 0, maximumAttempts: 2 },
    heartbeatIntervalMilliseconds: 60_000,
    webSocketFactory: (url, protocol) => {
      const socket = new FakeSocket(url, protocol);
      if (sockets.length === 0) {
        socket.send = () => {
          throw new Error("send failed");
        };
      }
      sockets.push(socket);
      return socket;
    },
  });

  await client.connect();
  await assert.rejects(client.publish("topics/orders", { value: 1 }), /send failed/i);
  await waitUntil(() => sockets.length === 2 && client.state === "open", "client did not reconnect after send failure");
  const publish = client.publish("topics/orders", { value: 2 });
  await waitUntil(() => sockets[1].sent.length === 1, "publish was not retried on the recovered socket");
  sockets[1].serverMessage(acknowledgement(JSON.parse(sockets[1].sent[0])));
  await publish;
  await client.disconnect();
});

test("reconnect backoff advances after an immediate retry", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const delays = [];
  globalThis.setTimeout = (handler, delay = 0, ...args) => {
    delays.push(delay);
    return originalSetTimeout(handler, 0, ...args);
  };

  try {
    const sockets = [];
    const client = new RealtimeClient({
      url: "wss://gateway.example/realtime/ws",
      reconnect: { initialDelayMilliseconds: 0, maximumDelayMilliseconds: 4, jitterRatio: 0, maximumAttempts: 3 },
      heartbeatIntervalMilliseconds: 60_000,
      authentication: {
        kind: "ticket",
        fetch: async () => new Response(JSON.stringify({
          ticket: `reconnect-ticket-${String(sockets.length + 1).padStart(32, "0")}`,
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
        }), { status: 200, headers: { "Content-Type": "application/json" } }),
      },
      webSocketFactory: (url, protocol) => {
        const socket = new FakeSocket(url, protocol, sockets.length === 0);
        sockets.push(socket);
        return socket;
      },
    });

    await client.connect();
    sockets[0].serverClose();
    await waitUntil(() => sockets.length === 2, "first reconnect attempt was not started");
    sockets[1].serverClose();
    await waitUntil(() => delays.includes(1), "second reconnect delay was not scheduled");
    assert.ok(delays.includes(0), "initial immediate reconnect delay was not scheduled");
    await client.disconnect();
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("invalid close arguments do not tear down an open client", async () => {
  let socket;
  const client = new RealtimeClient({
    url: "ws://gateway.example/realtime/ws",
    webSocketFactory: (url, protocol) => (socket = new FakeSocket(url, protocol)),
    heartbeatIntervalMilliseconds: 60_000,
  });
  await client.connect();
  await assert.rejects(client.disconnect(1001), RangeError);
  await assert.rejects(client.disconnect(3000, "é".repeat(62)), RangeError);
  assert.equal(client.state, "open");
  assert.equal(socket.readyState, 1);
  await client.disconnect();
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

test("consumer listener failures cannot interrupt client lifecycle or event dispatch", async () => {
  let socket;
  let delivered = 0;
  const client = new RealtimeClient({
    url: "ws://gateway.example/realtime/ws",
    reconnect: { enabled: false },
    webSocketFactory: (url, protocol) => (socket = new FakeSocket(url, protocol)),
    heartbeatIntervalMilliseconds: 60_000,
  });
  client.on("state", () => { throw new Error("state listener failed"); });
  client.on("close", () => { throw new Error("close listener failed"); });
  await client.connect();
  const first = client.subscribe("topics/orders", () => { throw new Error("event listener failed"); });
  await waitUntil(() => socket.sent.length === 1, "subscription was not sent");
  socket.serverMessage(acknowledgement(JSON.parse(socket.sent[0])));
  await first;
  await client.subscribe("topics/orders", () => { delivered += 1; });
  socket.serverMessage({
    version: PROTOCOL_VERSION,
    type: "event",
    correlationId: "event-listener-isolation",
    timestamp: new Date().toISOString(),
    route: "topics/orders",
    payload: { value: 42 },
  });
  assert.equal(delivered, 1);
  socket.serverClose();
  assert.equal(client.state, "closed");
});
