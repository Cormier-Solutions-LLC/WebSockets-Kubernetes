import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import request from "supertest";
import { createApp } from "../src/app.mjs";

const exampleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fixture(overrides = {}) {
  const values = new Map();
  const redisClient = {
    isReady: true,
    async set(key, value) { values.set(key, value); },
    async get(key) { return values.get(key) ?? null; },
    async del(key) { return values.delete(key) ? 1 : 0; },
  };
  const proxyCalls = [];
  const proxy = {
    web(incoming, response, options) {
      proxyCalls.push({ path: incoming.url, options });
      response.status(202).json({ forwarded: true });
    },
  };
  const logs = [];
  const logger = { error(entry) { logs.push(entry); } };
  const config = {
    trustProxyHops: 0,
    publicOrigin: "http://127.0.0.1:15100",
    publicScheme: "http",
    gatewayUrl: "http://127.0.0.1:15101",
    sessionSecret: "a-runtime-only-secret-that-is-long-enough",
    sessionLifetimeSeconds: 1200,
    instanceName: "node-express-a",
    topology: "non-ha",
    redisInstancePrefix: "cormier:reference-node",
    redisSessionKeyPrefix: "sessions",
    allowedTenants: ["tenant-a", "tenant-b"],
    allowedUsers: ["user-a", "user-b"],
    sharedAssetRoot: path.resolve(exampleRoot, "..", "shared-web", "wwwroot"),
    sdkAssetRoot: path.resolve(exampleRoot, "..", "..", "sdk", "typescript", "dist"),
    ...overrides,
  };
  return { app: createApp({ config, redisClient, proxy, logger }), config, redisClient, proxyCalls, logs, values };
}

function login(agent, config) {
  return agent.post("/api/login")
    .set("Origin", config.publicOrigin)
    .send({ tenantId: "tenant-a", userId: "user-a" });
}

test("reports dependency-aware health and redacted diagnostics", async () => {
  const ready = fixture();
  const response = await request(ready.app).get("/health").expect(200);
  assert.deepEqual(response.body, { status: "healthy" });
  const diagnostics = await request(ready.app).get("/api/diagnostics").expect(200);
  assert.equal(diagnostics.body.stack, "Node.js / Express");
  assert.equal(diagnostics.body.instance, ready.config.instanceName);
  assert.equal(JSON.stringify(diagnostics.body).includes("secret"), false);

  ready.redisClient.isReady = false;
  await request(ready.app).get("/health").expect(503, { status: "unavailable" });
});

test("rejects missing origins and identities without creating sessions", async () => {
  const context = fixture();
  await request(context.app).post("/api/login")
    .send({ tenantId: "tenant-a", userId: "user-a" })
    .expect(403);
  await request(context.app).post("/api/login")
    .set("Origin", context.config.publicOrigin)
    .send({ tenantId: "tenant-a", userId: "unknown" })
    .expect(400);
  await request(context.app).post("/realtime/tickets")
    .set("Origin", context.config.publicOrigin)
    .expect(401);
  assert.equal(context.values.size, 0);
  assert.equal(context.proxyCalls.length, 0);
});

test("establishes, validates, forwards, expires, and removes a session", async () => {
  const context = fixture();
  const agent = request.agent(context.app);
  const loginResponse = await login(agent, context.config).expect(200);
  assert.deepEqual(Object.keys(loginResponse.body).sort(), ["expiresAt", "tenantId", "userId"]);
  assert.equal(loginResponse.body.tenantId, "tenant-a");
  assert.equal(context.values.size, 1);
  const [redisKey] = context.values.keys();
  assert.match(redisKey, /^cormier:reference-node:sessions:[a-f0-9]{48}$/);
  assert.equal(loginResponse.text.includes(redisKey), false);

  const current = await agent.get("/api/session").expect(200);
  assert.equal(current.body.authenticated, true);
  assert.equal(current.body.tenantId, "tenant-a");

  const activeRecord = JSON.parse(context.values.get(redisKey));
  context.values.set(redisKey, JSON.stringify({ ...activeRecord, revoked: true }));
  await agent.get("/api/session").expect(401, { authenticated: false });
  assert.equal(context.values.size, 0);

  await login(agent, context.config).expect(200);
  const [replacementKey] = context.values.keys();

  await agent.post("/realtime/tickets")
    .set("Origin", context.config.publicOrigin)
    .expect(202, { forwarded: true });
  assert.deepEqual(context.proxyCalls, [{
    path: "/realtime/tickets",
    options: {
      target: context.config.gatewayUrl,
      changeOrigin: false,
      xfwd: false,
      headers: { "x-forwarded-proto": "http" },
      proxyTimeout: 10_000,
      timeout: 10_000,
    },
  }]);

  const record = JSON.parse(context.values.get(replacementKey));
  context.values.set(replacementKey, JSON.stringify({ ...record, expiresAt: new Date(0).toISOString() }));
  await agent.get("/api/session").expect(401, { authenticated: false });
  assert.equal(context.values.size, 0);

  await login(agent, context.config).expect(200);
  await agent.post("/api/logout").set("Origin", context.config.publicOrigin).expect(204);
  assert.equal(context.values.size, 0);
  await agent.get("/api/session").expect(401, { authenticated: false });
});

test("honors configured trusted proxy hops for secure session cookies", async () => {
  const context = fixture({ publicOrigin: "https://example.test", trustProxyHops: 1 });
  const response = await request(context.app).post("/api/login")
    .set("Origin", context.config.publicOrigin)
    .set("X-Forwarded-Proto", "https")
    .send({ tenantId: "tenant-a", userId: "user-a" })
    .expect(200);
  const cookies = response.headers["set-cookie"].join(";");
  assert.match(cookies, /cormier_example_session=/);
  assert.match(cookies, /Secure/);
});

test("serves only the canonical shared UI and generated SDK", async () => {
  const context = fixture();
  const page = await request(context.app).get("/").expect(200);
  assert.match(page.text, /Cormier\.Realtime full circle/);
  assert.match((await request(context.app).get("/app.js").expect(200)).text, /CormierRealtime\.RealtimeClient/);
  const sdk = await request(context.app)
    .get("/_content/Cormier.Realtime.Browser/cormier-realtime.iife.js")
    .expect(200);
  assert.match(sdk.text, /CormierRealtime/);
});

test("returns generic dependency failures and logs no sensitive values", async () => {
  const context = fixture();
  context.redisClient.set = async () => { throw new TypeError("redis://user:secret@example.test"); };
  const response = await login(request(context.app), context.config).expect(503);
  assert.deepEqual(response.body, {
    code: "service_unavailable",
    message: "The reference application dependency is unavailable.",
  });
  assert.deepEqual(context.logs, [
    { event: "login_failed", error: "TypeError" },
    { event: "request_failed", error: "Error" },
  ]);
  assert.equal(JSON.stringify(context.logs).includes("secret"), false);
});

test("returns a generic gateway failure when forwarding cannot start", async () => {
  const context = fixture();
  const failure = new Error("http://internal-gateway.invalid/private");

  // Recreate the app because the proxy is intentionally injected as a boundary dependency.
  const failingProxy = { web() { throw failure; } };
  const logs = [];
  const app = createApp({
    config: context.config,
    redisClient: context.redisClient,
    proxy: failingProxy,
    logger: { error(entry) { logs.push(entry); } },
  });
  const failingAgent = request.agent(app);
  await login(failingAgent, context.config).expect(200);
  const response = await failingAgent.post("/realtime/tickets")
    .set("Origin", context.config.publicOrigin)
    .expect(503);
  assert.equal(response.body.code, "service_unavailable");
  assert.equal(JSON.stringify(logs).includes("internal-gateway"), false);
});
