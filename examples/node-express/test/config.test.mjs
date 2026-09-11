import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";

const validEnvironment = Object.freeze({
  LISTEN_HOST: "127.0.0.1",
  PORT: "15100",
  TRUST_PROXY_HOPS: "0",
  PUBLIC_ORIGIN: "http://127.0.0.1:15100",
  GATEWAY_URL: "http://127.0.0.1:15101",
  REDIS_URL: "redis://user:password@127.0.0.1:16379/2",
  SESSION_SECRET: "a-runtime-only-secret-that-is-long-enough",
  SESSION_LIFETIME_SECONDS: "1200",
  INSTANCE_NAME: "node-express-a",
  TOPOLOGY: "non-ha",
  REDIS_INSTANCE_PREFIX: "cormier:reference-node",
  REDIS_SESSION_KEY_PREFIX: "sessions",
  ALLOWED_TENANTS: "tenant-a,tenant-b",
  ALLOWED_USERS: "user-a,user-b",
});

test("loads and normalizes explicit configuration", () => {
  const config = loadConfig(validEnvironment);
  assert.equal(config.listenHost, "127.0.0.1");
  assert.equal(config.port, 15100);
  assert.equal(config.trustProxyHops, 0);
  assert.equal(config.publicOrigin, "http://127.0.0.1:15100");
  assert.equal(config.gatewayUrl, "http://127.0.0.1:15101");
  assert.equal(config.redisUrl, "redis://user:password@127.0.0.1:16379/2");
  assert.deepEqual(config.allowedTenants, ["tenant-a", "tenant-b"]);
  assert.ok(Object.isFrozen(config));
});

test("rejects missing or unsafe configuration", () => {
  for (const name of Object.keys(validEnvironment)) {
    assert.throws(() => loadConfig({ ...validEnvironment, [name]: "" }), new RegExp(name));
  }
  assert.throws(() => loadConfig({ ...validEnvironment, PORT: "80" }), /PORT/);
  assert.throws(() => loadConfig({ ...validEnvironment, PUBLIC_ORIGIN: "https://example.test/path" }), /PUBLIC_ORIGIN/);
  assert.throws(() => loadConfig({ ...validEnvironment, PUBLIC_ORIGIN: "https://example.test:443" }), /PUBLIC_ORIGIN/);
  assert.throws(() => loadConfig({ ...validEnvironment, TRUST_PROXY_HOPS: "17" }), /TRUST_PROXY_HOPS/);
  assert.throws(() => loadConfig({ ...validEnvironment, GATEWAY_URL: "file:///tmp/gateway" }), /GATEWAY_URL/);
  assert.throws(() => loadConfig({ ...validEnvironment, REDIS_URL: "https://example.test" }), /REDIS_URL/);
  assert.throws(() => loadConfig({ ...validEnvironment, TOPOLOGY: "maybe" }), /TOPOLOGY/);
  assert.throws(() => loadConfig({ ...validEnvironment, ALLOWED_USERS: "user-a,bad user" }), /ALLOWED_USERS/);
});
