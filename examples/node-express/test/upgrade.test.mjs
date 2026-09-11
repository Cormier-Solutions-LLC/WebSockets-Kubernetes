import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createUpgradeHandler } from "../src/upgrade.mjs";

function fixture() {
  const calls = [];
  const proxyRequest = new EventEmitter();
  proxyRequest.destroyed = false;
  proxyRequest.destroyedWith = undefined;
  proxyRequest.destroy = (error) => {
    proxyRequest.destroyed = true;
    proxyRequest.destroyedWith = error;
  };
  const proxy = new EventEmitter();
  proxy.ws = (...args) => {
    calls.push(args);
    proxy.emit("proxyReqWs", proxyRequest, args[0], args[1]);
  };
  const upgradedSockets = new Set();
  let deadline;
  const cancelled = [];
  const handler = createUpgradeHandler({
    publicOrigin: "http://127.0.0.1:15100",
    publicScheme: "http",
    gatewayUrl: "http://127.0.0.1:15101",
    proxy,
    upgradedSockets,
    schedule(callback, milliseconds) {
      deadline = { callback, milliseconds };
      return deadline;
    },
    cancel(value) { cancelled.push(value); },
  });
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.destroy = () => { socket.destroyed = true; };
  return { calls, handler, socket, upgradedSockets, proxyRequest, get deadline() { return deadline; }, cancelled };
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
    xfwd: false,
    headers: { "x-forwarded-proto": "http" },
  }]]);
  assert.equal(context.deadline.milliseconds, 10_000);
});

test("destroys both sides when the gateway websocket handshake exceeds its deadline", () => {
  const context = fixture();
  context.handler({ url: "/realtime/ws" }, context.socket, Buffer.alloc(0));
  context.deadline.callback();
  assert.match(context.proxyRequest.destroyedWith.message, /timed out/);
  assert.equal(context.socket.destroyed, true);
});

test("cancels the gateway websocket handshake deadline after upgrade", () => {
  const context = fixture();
  context.handler({ url: "/realtime/ws" }, context.socket, Buffer.alloc(0));
  context.proxyRequest.emit("upgrade");
  assert.deepEqual(context.cancelled, [context.deadline]);
});

test("cancels the handshake and upstream request when the browser disconnects", () => {
  const context = fixture();
  context.handler({ url: "/realtime/ws" }, context.socket, Buffer.alloc(0));
  context.socket.emit("close");
  assert.deepEqual(context.cancelled, [context.deadline]);
  assert.equal(context.proxyRequest.destroyed, true);
});
