import crypto from "node:crypto";
import path from "node:path";
import express from "express";
import { rateLimit } from "express-rate-limit";
import session from "express-session";

const gatewayCookieName = "cormier_session";
const exampleCookieName = "cormier_example_session";

function noStore(response) {
  response.set("cache-control", "no-store");
}

async function redisReady(redisClient) {
  if (redisClient.isReady !== true) return false;
  try {
    return await redisClient.ping() === "PONG";
  } catch {
    return false;
  }
}

function requireOrigin(config) {
  return (request, response, next) => {
    if (request.get("origin") !== config.publicOrigin) {
      noStore(response);
      response.status(403).json({ code: "origin_rejected", message: "The request Origin is not allowed." });
      return;
    }
    next();
  };
}

function requireSession(request, response, next) {
  if (!request.session.identity) {
    noStore(response);
    response.status(401).json({ code: "authentication_required", message: "Log in before requesting a connection ticket." });
    return;
  }
  next();
}

export function createApp({ config, redisClient, proxy, logger = console }) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxyHops === 0 ? false : config.trustProxyHops);
  app.use((request, response, next) => {
    response.set({
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self'; style-src 'self'; script-src 'self'",
    });
    next();
  });
  app.use(express.json({ limit: "8kb", strict: true }));
  app.use(rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { code: "rate_limited", message: "Too many requests." },
  }));
  app.use(session({
    name: exampleCookieName,
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "strict",
      secure: config.publicOrigin.startsWith("https://"),
      maxAge: config.sessionLifetimeSeconds * 1_000,
    },
  }));

  app.get("/health", async (_request, response) => {
    const ready = await redisReady(redisClient);
    noStore(response);
    response.status(ready ? 200 : 503).json({ status: ready ? "healthy" : "unavailable" });
  });

  app.get("/api/diagnostics", async (_request, response) => {
    const ready = await redisReady(redisClient);
    noStore(response);
    response.json({
      stack: "Node.js / Express",
      topology: config.topology,
      instance: config.instanceName,
      redis: ready ? "ready" : "unavailable",
      timestamp: new Date().toISOString(),
    });
  });

  app.post("/api/login", requireOrigin(config), async (request, response, next) => {
    try {
      const { tenantId, userId } = request.body ?? {};
      if (!config.allowedTenants.includes(tenantId) || !config.allowedUsers.includes(userId)) {
        noStore(response);
        response.status(400).json({ code: "invalid_identity", message: "Select a configured test tenant and user." });
        return;
      }
      const sessionId = crypto.randomBytes(24).toString("hex");
      const expiresAt = new Date(Date.now() + config.sessionLifetimeSeconds * 1_000);
      const record = JSON.stringify({
        tenantId,
        userId,
        allowedTopics: ["orders", "notifications"],
        expiresAt: expiresAt.toISOString(),
        revoked: false,
      });
      await redisClient.set(
        `${config.redisInstancePrefix}:${config.redisSessionKeyPrefix}:${sessionId}`,
        record,
        { EX: config.sessionLifetimeSeconds },
      );
      request.session.identity = { sessionId, tenantId, userId, expiresAt: expiresAt.toISOString() };
      response.cookie(gatewayCookieName, sessionId, {
        httpOnly: true,
        sameSite: "strict",
        secure: config.publicOrigin.startsWith("https://"),
        maxAge: config.sessionLifetimeSeconds * 1_000,
        path: "/",
      });
      noStore(response);
      response.json({ tenantId, userId, expiresAt: expiresAt.toISOString() });
    } catch (error) {
      logger.error?.({ event: "login_failed", error: error?.name ?? "Error" });
      next(new Error("The session store is unavailable."));
    }
  });

  app.post("/api/logout", requireOrigin(config), async (request, response, next) => {
    try {
      const sessionId = request.session.identity?.sessionId;
      if (sessionId) {
        await redisClient.del(`${config.redisInstancePrefix}:${config.redisSessionKeyPrefix}:${sessionId}`);
      }
      await new Promise((resolve, reject) => request.session.destroy((error) => error ? reject(error) : resolve()));
      response.clearCookie(exampleCookieName, { path: "/" });
      response.clearCookie(gatewayCookieName, { path: "/" });
      noStore(response);
      response.sendStatus(204);
    } catch (error) {
      logger.error?.({ event: "logout_failed", error: error?.name ?? "Error" });
      next(new Error("The session store is unavailable."));
    }
  });

  app.get("/api/session", async (request, response, next) => {
    try {
      const identity = request.session.identity;
      if (!identity) {
        noStore(response);
        response.status(401).json({ authenticated: false });
        return;
      }
      const stored = await redisClient.get(
        `${config.redisInstancePrefix}:${config.redisSessionKeyPrefix}:${identity.sessionId}`,
      );
      if (!stored) {
        noStore(response);
        response.status(401).json({ authenticated: false });
        return;
      }
      const record = JSON.parse(stored);
      const expiresAt = Date.parse(record.expiresAt);
      if (record.revoked === true || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        await redisClient.del(`${config.redisInstancePrefix}:${config.redisSessionKeyPrefix}:${identity.sessionId}`);
        noStore(response);
        response.status(401).json({ authenticated: false });
        return;
      }
      noStore(response);
      response.json({
        authenticated: true,
        tenantId: record.tenantId,
        userId: record.userId,
        allowedTopics: record.allowedTopics,
        expiresAt: record.expiresAt,
      });
    } catch (error) {
      logger.error?.({ event: "session_lookup_failed", error: error?.name ?? "Error" });
      next(new Error("The session store is unavailable."));
    }
  });

  app.post("/realtime/tickets", requireOrigin(config), requireSession, (request, response) => {
    proxy.web(request, response, {
      target: config.gatewayUrl,
      changeOrigin: false,
      xfwd: false,
      headers: { "x-forwarded-proto": config.publicScheme },
      proxyTimeout: 10_000,
      timeout: 10_000,
    });
  });

  app.use("/_content/Cormier.Realtime.Browser", express.static(config.sdkAssetRoot, { index: false, fallthrough: false }));
  app.use(express.static(config.sharedAssetRoot, { index: false, fallthrough: true }));
  app.get("/", (_request, response) => response.sendFile(path.join(config.sharedAssetRoot, "index.html")));

  app.use((error, _request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }
    noStore(response);
    if (["entity.parse.failed", "entity.too.large"].includes(error?.type) && [400, 413].includes(error?.status)) {
      logger.error?.({ event: "request_rejected", error: error.type });
      response.status(error.status).json({ code: "invalid_request", message: "The request body is invalid." });
      return;
    }
    logger.error?.({ event: "request_failed", error: error?.name ?? "Error" });
    response.status(503).json({ code: "service_unavailable", message: "The reference application dependency is unavailable." });
  });
  return app;
}
