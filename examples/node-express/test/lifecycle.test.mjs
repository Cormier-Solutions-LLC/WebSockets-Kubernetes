import assert from "node:assert/strict";
import test from "node:test";
import { connectWithDeadline, createShutdown } from "../src/lifecycle.mjs";

test("bounds Redis startup readiness", async () => {
  const redisClient = { connect: () => new Promise(() => {}) };
  await assert.rejects(connectWithDeadline(redisClient, 10), { name: "StartupTimeoutError" });
});

test("graceful shutdown closes each dependency once", async () => {
  const calls = [];
  const upgradedSockets = new Set();
  const stop = createShutdown({
    server: { close(callback) { calls.push("server"); callback(); } },
    proxy: { close() { calls.push("proxy"); } },
    redisClient: { isOpen: true, async quit() { calls.push("redis"); } },
    upgradedSockets,
    log(entry) { calls.push(entry.event); },
    timeoutMilliseconds: 100,
    forceExit() { calls.push("forced"); },
  });
  await stop("SIGTERM");
  await stop("SIGTERM");
  assert.deepEqual(calls, ["stopping", "server", "proxy", "redis"]);
});

test("shutdown sends Going Away and force-closes websocket pairs only at the deadline", async () => {
  const writes = [];
  const destroyed = [];
  const socket = name => ({
    writable: true,
    destroyed: false,
    write(frame) { writes.push([name, frame]); },
    destroy() { this.destroyed = true; destroyed.push(name); },
  });
  const upgradedSockets = new Set([{ browser: socket("browser"), gateway: socket("gateway") }]);
  const stop = createShutdown({
    server: { close(callback) { callback(); } },
    proxy: { close() {} },
    redisClient: { isOpen: false },
    upgradedSockets,
    log() {},
    timeoutMilliseconds: 10,
    forceExit() { assert.fail("shutdown exceeded the force-exit allowance"); },
  });

  await stop("SIGTERM");
  assert.equal(writes.length, 2);
  assert.equal(writes[0][1][0], 0x88);
  assert.equal(writes[0][1].readUInt16BE(2), 1001);
  assert.equal(writes[1][1][1] & 0x80, 0x80);
  assert.deepEqual(destroyed.sort(), ["browser", "gateway"]);
});

test("shutdown waits for websocket relays that complete their close handshake", async () => {
  const upgradedSockets = new Set();
  let destroyed = false;
  const browser = { writable: true, destroyed: false, write() {}, destroy() { destroyed = true; } };
  const gateway = {
    writable: true,
    destroyed: false,
    write() { setTimeout(() => upgradedSockets.clear(), 0); },
    destroy() { destroyed = true; },
  };
  upgradedSockets.add({ browser, gateway });
  const stop = createShutdown({
    server: { close(callback) { callback(); } },
    proxy: { close() {} },
    redisClient: { isOpen: false },
    upgradedSockets,
    log() {},
    timeoutMilliseconds: 100,
    forceExit() { assert.fail("shutdown exceeded the force-exit allowance"); },
  });

  await stop("SIGTERM");
  assert.equal(destroyed, false);
});
