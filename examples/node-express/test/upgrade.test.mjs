import assert from "node:assert/strict";
import test from "node:test";
import { createUpgradeHandler } from "../src/upgrade.mjs";

function fixture() {
  const calls = [];
  const proxy = { ws(...args) { calls.push(args); } };
  const upgradedSockets = new Set();
  const handler = createUpgradeHandler({
    publicOrigin: "http://127.0.0.1:15100",
    gatewayUrl: "http://127.0.0.1:15101",
    proxy,
    upgradedSockets,
  });
  const socket = {
    destroyed: false,
    destroy() { this.destroyed = true; },
    once() {},
  };
  return { calls, handler, socket, upgradedSockets };
}

test("destroys upgrades with malformed request targets", () => {
  const context = fixture();
  assert.doesNotThrow(() => context.handler({ url: "http://[invalid" }, context.socket, Buffer.alloc(0)));
  assert.equal(context.socket.destroyed, true);
  assert.equal(context.calls.length, 0);
  assert.equal(context.upgradedSockets.size, 0);
});

test("forwards only the configured websocket path", () => {
  const context = fixture();
  const request = { url: "/realtime/ws?ticket=example" };
  const head = Buffer.alloc(0);
  context.handler(request, context.socket, head);
  assert.equal(context.socket.destroyed, false);
  assert.equal(context.upgradedSockets.has(context.socket), true);
  assert.deepEqual(context.calls, [[request, context.socket, head, {
    target: "http://127.0.0.1:15101",
    changeOrigin: false,
  }]]);
});
