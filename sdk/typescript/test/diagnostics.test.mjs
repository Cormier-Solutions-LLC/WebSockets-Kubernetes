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

test("diagnostics streams expose an explicit disconnect function", () => {
  let source;
  class FakeEventSource {
    closed = false;
    onmessage;
    constructor(url) { this.url = url; source = this; }
    close() { this.closed = true; }
  }
  const client = new DiagnosticsClient({ eventSourceFactory: (url) => new FakeEventSource(url) });

  const disconnect = client.tailLogs({ level: "Warning", category: "Cormier.Realtime" }, () => {});

  assert.match(source.url, /^\/diagnostics\/v1\/logs\/tail\?/);
  disconnect();
  assert.equal(source.closed, true);
});
