import { createClient } from "redis";

const sessionId = "browser-session-123456";
const redisEndpoint = process.env.REDIS_TEST_ENDPOINT ?? "127.0.0.1:6379";
const redisUrl = redisEndpoint.includes("://") ? redisEndpoint : `redis://${redisEndpoint}`;

export default async function globalSetup() {
  const redis = createClient({ url: redisUrl });
  await redis.connect();
  const sessionKey = `cormier:browser-tests:sessions:${sessionId}`;
  await redis.set(sessionKey, JSON.stringify({
    tenantId: "browser-tenant",
    userId: "browser-user",
    allowedTopics: ["orders"],
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    revoked: false,
  }), { EX: 600 });
  const isolatedSessionKey = "cormier:browser-tests:sessions:isolated-session-123456";
  await redis.set(isolatedSessionKey, JSON.stringify({
    tenantId: "isolated-tenant",
    userId: "isolated-user",
    allowedTopics: ["orders"],
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    revoked: false,
  }), { EX: 600 });
  const expiredTicket = "expired-browser-ticket-12345678901234567890";
  await redis.set(`cormier:browser-tests:tickets:${expiredTicket}`, JSON.stringify({
    tenantId: "browser-tenant",
    userId: "browser-user",
    allowedTopics: ["orders"],
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
    audience: `127.0.0.1:${process.env.REALTIME_BROWSER_PROXY_PORT ?? "18083"}`,
  }), { EX: 600 });
  await redis.quit();

  return async () => {
    const cleanup = createClient({ url: redisUrl });
    await cleanup.connect();
    await cleanup.del(sessionKey, isolatedSessionKey, `cormier:browser-tests:tickets:${expiredTicket}`);
    await cleanup.quit();
  };
}
