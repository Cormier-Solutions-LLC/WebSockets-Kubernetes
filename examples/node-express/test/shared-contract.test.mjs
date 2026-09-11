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
});

test("generated SDK and canonical protocol fixture versions agree", async () => {
  const sdkVersion = JSON.parse(await readFile(path.join(repositoryRoot, "sdk/typescript/dist/version.json"), "utf8"));
  const fixture = JSON.parse(await readFile(path.join(repositoryRoot, "protocol/fixtures/v1/envelopes.json"), "utf8"));
  assert.equal(sdkVersion.protocolVersion, fixture.protocolVersion);
  assert.equal(sdkVersion.protocolVersion, "1.0");
});
