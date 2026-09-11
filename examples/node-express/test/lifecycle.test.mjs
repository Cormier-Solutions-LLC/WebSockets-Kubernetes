import assert from "node:assert/strict";
import test from "node:test";
import { connectWithDeadline, createShutdown } from "../src/lifecycle.mjs";

test("bounds Redis startup readiness", async () => {
  const redisClient = { connect: () => new Promise(() => {}) };
  await assert.rejects(connectWithDeadline(redisClient, 10), { name: "StartupTimeoutError" });
});

test("graceful shutdown closes each dependency once", async () => {
  const calls = [];
  const upgradedSockets = new Set([{ destroy() { calls.push("socket"); } }]);
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
  assert.deepEqual(calls, ["stopping", "server", "proxy", "socket", "redis"]);
});
