import test from "node:test";
import assert from "node:assert/strict";
import { DiagnosticsClient } from "../dist/cormier-realtime.js";

test("diagnostics client uses explicit operator headers and bounded control payloads", async () => {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, init });
    return new Response(JSON.stringify({
      id: "a".repeat(32),
      category: "Cormier.Realtime",
      level: "Debug",
      scope: "all",
      startedAt: "2026-01-01T00:00:00Z",
      expiresAt: "2026-01-01T00:05:00Z",
      state: "active",
    }), { status: 201, headers: { "content-type": "application/json" } });
  };
  const client = new DiagnosticsClient({
    baseUrl: "https://operator.example/diagnostics/v1/",
    headers: { authorization: "Bearer opaque" },
    fetch,
  });

  const result = await client.applyLogLevel({
    category: "Cormier.Realtime",
    level: "Debug",
    durationSeconds: 300,
    reason: "investigate queue pressure",
  });

  assert.equal(result.state, "active");
  assert.equal(requests[0].url, "https://operator.example/diagnostics/v1/logging/overrides");
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.credentials, "same-origin");
  assert.equal(requests[0].init.headers.authorization, "Bearer opaque");
  assert.equal(JSON.parse(requests[0].init.body).scope, "all");
});

test("diagnostics streams carry authentication and stop on server disconnect", async () => {
  const requests = [];
  const events = [];
  const fetch = async (url, init) => {
    requests.push({ url, init });
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"sequence":1,"message":"bounded"}\n\nevent: disconnect\ndata: {"reason":"rate_limit"}\n\n'));
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const client = new DiagnosticsClient({ headers: { authorization: "Bearer opaque" }, fetch });

  const disconnect = client.tailLogs({ level: "Warning", category: "Cormier.Realtime" }, (event) => events.push(event));
  for (let attempt = 0; attempt < 20 && !requests[0]?.init.signal.aborted; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  assert.match(requests[0].url, /^\/diagnostics\/v1\/logs\/tail\?/);
  assert.equal(requests[0].init.headers.authorization, "Bearer opaque");
  assert.equal(events[0].message, "bounded");
  assert.equal(requests[0].init.signal.aborted, true);
  disconnect();
});

test("diagnostics streams retry ordinary interruptions with authentication", async () => {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, init });
    const body = new ReadableStream({
      start(controller) {
        if (requests.length === 2) {
          controller.enqueue(new TextEncoder().encode('event: disconnect\ndata: {"reason":"complete"}\n\n'));
        }
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const client = new DiagnosticsClient({
    headers: { authorization: "Bearer opaque" },
    fetch,
    streamRetryMilliseconds: 100,
  });

  const disconnect = client.streamEvents(() => undefined);
  for (let attempt = 0; attempt < 50 && requests.length < 2; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.equal(requests.length, 2);
  assert.equal(requests[1].init.headers.authorization, "Bearer opaque");
  assert.equal(requests[1].init.signal.aborted, true);
  disconnect();
});

test("diagnostics streams stop after permanent client responses", async () => {
  let requests = 0;
  const errors = [];
  const client = new DiagnosticsClient({
    fetch: async () => {
      requests += 1;
      return new Response("unauthorized", { status: 401 });
    },
    onStreamError: (error) => errors.push(error),
    streamRetryMilliseconds: 100,
  });

  const disconnect = client.streamEvents(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.equal(requests, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /HTTP 401/);
  disconnect();
});

test("diagnostics streams retry transient server responses", async () => {
  let requests = 0;
  const client = new DiagnosticsClient({
    fetch: async () => {
      requests += 1;
      if (requests === 1) return new Response("unavailable", { status: 503 });
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('event: disconnect\ndata: {"reason":"complete"}\n\n'));
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    },
    streamRetryMilliseconds: 100,
  });

  const disconnect = client.streamEvents(() => undefined);
  for (let attempt = 0; attempt < 50 && requests < 2; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.equal(requests, 2);
  disconnect();
});
