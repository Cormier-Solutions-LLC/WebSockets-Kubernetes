import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const exampleDirectory = path.resolve(sourceDirectory, "..");
const repositoryRoot = path.resolve(exampleDirectory, "..", "..");
const safeScope = /^[A-Za-z0-9._-]{1,128}$/;
const safeHost = /^[A-Za-z0-9._:-]{1,253}$/;

function required(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    throw new Error("PORT must be an integer between 1024 and 65535.");
  }
  return port;
}

function parseOrigin(value, name) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL.`);
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(`${name} must be an HTTP or HTTPS origin URL.`);
  }
  const authority = value.match(/^https?:\/\/(\[[^\]]+\]|[^:/?#]+)(?::\d+)?$/);
  const rawHostname = authority?.[1]?.replace(/^\[|\]$/g, "") ?? "";
  const labels = rawHostname.split(".");
  const validDnsName = labels.every((label) => label.length >= 1 && label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label));
  const resemblesNumericAddress = /^\d+(?:\.\d+){0,3}$/.test(rawHostname);
  if (!authority || rawHostname.includes("%") || isIP(rawHostname) === 0 && (!validDnsName || resemblesNumericAddress)) {
    throw new Error(`${name} must contain a valid DNS name or IP address.`);
  }
  if (/^http:\/\/[^/?#]+:80(?:\/|$)/i.test(value) || /^https:\/\/[^/?#]+:443(?:\/|$)/i.test(value)) {
    throw new Error(`${name} must omit the default port.`);
  }
  return parsed;
}

function parseHost(value) {
  if (!safeHost.test(value)) throw new Error("LISTEN_HOST must be a safe host name or address.");
  return value;
}

function parseTrustProxyHops(value) {
  const hops = Number(value);
  if (!Number.isSafeInteger(hops) || hops < 0 || hops > 16) {
    throw new Error("TRUST_PROXY_HOPS must be an integer between 0 and 16.");
  }
  return hops;
}

function parseRedisUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("REDIS_URL must be an absolute URL.");
  }
  if (!["redis:", "rediss:"].includes(parsed.protocol) || !parsed.hostname || parsed.search || parsed.hash) {
    throw new Error("REDIS_URL must use the redis or rediss protocol.");
  }
  return parsed;
}

function parseScopes(value, name) {
  const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0 || entries.some((entry) => !safeScope.test(entry))) {
    throw new Error(`${name} must contain comma-separated safe identifiers.`);
  }
  return entries;
}

export function loadConfig(environment = process.env) {
  const publicOrigin = parseOrigin(required(environment, "PUBLIC_ORIGIN"), "PUBLIC_ORIGIN");
  const gatewayUrl = parseOrigin(required(environment, "GATEWAY_URL"), "GATEWAY_URL");
  const redisUrl = parseRedisUrl(required(environment, "REDIS_URL"));
  const sessionSecret = required(environment, "SESSION_SECRET");
  if (sessionSecret.length < 32 || sessionSecret.length > 4096) {
    throw new Error("SESSION_SECRET must contain between 32 and 4096 characters.");
  }
  const instanceName = required(environment, "INSTANCE_NAME");
  if (!safeScope.test(instanceName)) throw new Error("INSTANCE_NAME must be a safe identifier.");
  const topology = required(environment, "TOPOLOGY");
  if (!["non-ha", "ha"].includes(topology)) throw new Error("TOPOLOGY must be non-ha or ha.");
  const redisInstancePrefix = required(environment, "REDIS_INSTANCE_PREFIX");
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(redisInstancePrefix)) {
    throw new Error("REDIS_INSTANCE_PREFIX must be a safe Redis key prefix.");
  }
  const redisSessionKeyPrefix = required(environment, "REDIS_SESSION_KEY_PREFIX");
  if (!safeScope.test(redisSessionKeyPrefix)) {
    throw new Error("REDIS_SESSION_KEY_PREFIX must be a safe identifier.");
  }
  const sessionLifetimeSeconds = Number(required(environment, "SESSION_LIFETIME_SECONDS"));
  if (!Number.isSafeInteger(sessionLifetimeSeconds) || sessionLifetimeSeconds < 60 || sessionLifetimeSeconds > 7200) {
    throw new Error("SESSION_LIFETIME_SECONDS must be an integer between 60 and 7200.");
  }
  const heartbeatIntervalMilliseconds = Number(required(environment, "HEARTBEAT_INTERVAL_MILLISECONDS"));
  if (!Number.isSafeInteger(heartbeatIntervalMilliseconds) || heartbeatIntervalMilliseconds < 5_000 || heartbeatIntervalMilliseconds > 300_000) {
    throw new Error("HEARTBEAT_INTERVAL_MILLISECONDS must be an integer between 5000 and 300000.");
  }

  return Object.freeze({
    listenHost: parseHost(required(environment, "LISTEN_HOST")),
    port: parsePort(required(environment, "PORT")),
    trustProxyHops: parseTrustProxyHops(required(environment, "TRUST_PROXY_HOPS")),
    publicOrigin: publicOrigin.origin,
    publicScheme: publicOrigin.protocol.slice(0, -1),
    gatewayUrl: gatewayUrl.origin,
    redisUrl: redisUrl.toString(),
    sessionSecret,
    sessionLifetimeSeconds,
    heartbeatIntervalMilliseconds,
    instanceName,
    topology,
    redisInstancePrefix,
    redisSessionKeyPrefix,
    allowedTenants: parseScopes(required(environment, "ALLOWED_TENANTS"), "ALLOWED_TENANTS"),
    allowedUsers: parseScopes(required(environment, "ALLOWED_USERS"), "ALLOWED_USERS"),
    sharedAssetRoot: path.resolve(environment.SHARED_ASSET_ROOT ?? path.join(repositoryRoot, "examples", "shared-web", "wwwroot")),
    sdkAssetRoot: path.resolve(environment.SDK_ASSET_ROOT ?? path.join(repositoryRoot, "sdk", "typescript", "dist")),
  });
}
