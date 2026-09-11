import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

test("configuration stays aligned with the canonical reference schema", async () => {
  const schema = JSON.parse(await readFile(path.join(repositoryRoot, "examples/shared-web/reference-app.schema.json"), "utf8"));
  const environment = Object.fromEntries(schema.required.map(name => [name, ({
    LISTEN_HOST: "127.0.0.1",
    PORT: "15100",
    PUBLIC_ORIGIN: "http://127.0.0.1:15100",
    GATEWAY_URL: "http://127.0.0.1:15101",
    REDIS_URL: "redis://127.0.0.1:16379",
    SESSION_SECRET: "a-runtime-only-secret-that-is-long-enough",
    SESSION_LIFETIME_SECONDS: "1200",
    INSTANCE_NAME: "node-express-a",
    TOPOLOGY: "non-ha",
    REDIS_INSTANCE_PREFIX: "cormier:reference-node",
    REDIS_SESSION_KEY_PREFIX: "sessions",
    ALLOWED_TENANTS: "tenant-a,tenant-b",
    ALLOWED_USERS: "user-a,user-b",
  })[name]]));
  environment.SESSION_SECRET = "a-runtime-only-secret-that-is-long-enough";
  environment.TRUST_PROXY_HOPS = "0";
  assert.equal(Object.keys(environment).length, 14);
  assert.doesNotThrow(() => loadConfig(environment));

  const originSchema = schema.$defs.httpOrigin;
  const acceptsOrigin = (value) => new RegExp(originSchema.pattern).test(value)
    && !originSchema.not.anyOf.some(({ pattern }) => new RegExp(pattern).test(value));
  assert.equal(acceptsOrigin("https://example.test"), true);
  assert.equal(acceptsOrigin("https://example.test:65535"), true);
  assert.equal(acceptsOrigin("http://127.0.0.1:15100"), true);
  assert.equal(acceptsOrigin("https://[::1]"), true);
  assert.equal(acceptsOrigin("https://[2001:db8::1]"), true);
  assert.equal(acceptsOrigin("https://[::1:1:1:1:1:1:1]"), true);
  assert.equal(acceptsOrigin("https://[1:1:1:1:1:1:1::]"), true);
  assert.equal(acceptsOrigin("https://[::]"), true);
  for (const value of [
    "https://user@example.test",
    "https://example.test/path",
    "https://example.test?route=x",
    "https://example.test#fragment",
    "https://example.test:443",
    "https://example.test:0",
    "https://example.test:65536",
    "https://example.test:99999",
    "https://EXAMPLE.TEST",
    "https://a..b",
    "https://999.999.999.999",
    "https://[:::]",
    "https://[.]",
    "https://[1:2:3]",
    "https://[1:2:3:4:5:6:7:8:9]",
    "https://[1::2::3]",
  ]) {
    assert.equal(acceptsOrigin(value), false, value);
  }
  assert.deepEqual(schema.properties.APP_URL, { $ref: "#/$defs/httpUpstream" });
  const acceptsHttpUpstream = value => acceptsOrigin(value) && /^http:\/\//.test(value);
  assert.equal(acceptsHttpUpstream("http://127.0.0.1:15502"), true);
  for (const value of ["https://app.example.test", "ftp://app.example.test", "http://app.example.test/path"]) {
    assert.equal(acceptsHttpUpstream(value), false, value);
  }

  const portPattern = new RegExp(schema.$defs.port.pattern);
  for (const value of ["1024", "15100", "65535"]) assert.equal(portPattern.test(value), true, value);
  for (const value of ["0", "1023", "65536", "999999"]) assert.equal(portPattern.test(value), false, value);

  const redisPattern = new RegExp(schema.$defs.redisUrl.pattern);
  assert.equal(redisPattern.test("redis://127.0.0.1:6379"), true);
  assert.equal(redisPattern.test("rediss://cache.example.test:6380"), true);
  assert.equal(redisPattern.test("redis://user:password@cache.example.test:6379/2"), true);
  for (const value of ["https://cache.example.test", "redis:///0", "redis://cache.example.test/0#fragment", "redis://cache.example.test:99999"]) {
    assert.equal(redisPattern.test(value), false, value);
  }

  const secretPattern = new RegExp(schema.properties.SESSION_SECRET.pattern);
  assert.equal(secretPattern.test("a".repeat(32)), true);
  assert.equal(secretPattern.test("a".repeat(4096)), true);
  assert.equal(secretPattern.test(`${"a".repeat(31)}💥`), false);
  assert.equal(secretPattern.test(`${"a".repeat(32)}\n`), false);

  const lifetimePattern = new RegExp(schema.$defs.sessionLifetime.pattern);
  for (const value of ["60", "1200", "7200"]) assert.equal(lifetimePattern.test(value), true, value);
  for (const value of ["0", "59", "7201", "999999"]) assert.equal(lifetimePattern.test(value), false, value);

  const allowlistPattern = new RegExp(schema.$defs.allowlist.pattern);
  for (const value of ["tenant-a", "tenant-a,tenant_b", " tenant-a, tenant.b "]) {
    assert.equal(allowlistPattern.test(value), true, value);
  }
  for (const value of ["", " ", "tenant a", "tenant-a,", ",tenant-a", "tenant-a,,tenant-b"]) {
    assert.equal(allowlistPattern.test(value), false, value);
  }
});

test("generated SDK and canonical protocol fixture versions agree", async () => {
  const sdkVersion = JSON.parse(await readFile(path.join(repositoryRoot, "sdk/typescript/dist/version.json"), "utf8"));
  const fixture = JSON.parse(await readFile(path.join(repositoryRoot, "protocol/fixtures/v1/envelopes.json"), "utf8"));
  assert.equal(sdkVersion.protocolVersion, fixture.protocolVersion);
  assert.equal(sdkVersion.protocolVersion, "1.0");
});
