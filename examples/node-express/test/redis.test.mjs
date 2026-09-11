import assert from "node:assert/strict";
import test from "node:test";
import { createRedisOptions, redisCommandTimeoutMilliseconds } from "../src/redis.mjs";

test("bounds every Redis command with an explicit response timeout", () => {
  assert.deepEqual(createRedisOptions("redis://127.0.0.1:6379"), {
    url: "redis://127.0.0.1:6379",
    commandOptions: { timeout: redisCommandTimeoutMilliseconds },
  });
  assert.equal(redisCommandTimeoutMilliseconds, 5_000);
});
