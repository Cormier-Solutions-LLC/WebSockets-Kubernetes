import { createClient, createSentinel } from "redis";

const action = process.argv[2];
if (action !== "ping" && action !== "cleanup") {
  throw new Error("Redis fixture action must be ping or cleanup.");
}

function required(name) {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) throw new Error(`${name} is required.`);
  return value;
}

function parseNode(value) {
  const parsed = new URL(`redis://${value.trim()}`);
  if ((parsed.pathname !== "" && parsed.pathname !== "/") || parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw new Error("Redis__Endpoint entries must contain only a host and port.");
  }
  const port = Number(parsed.port || 6379);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("Redis endpoint port is invalid.");
  return { host: parsed.hostname, port };
}

const endpoints = required("Redis__Endpoint").split(",").map(parseNode);
const username = process.env.Redis__User || undefined;
const password = process.env.Redis__Password || undefined;
const sentinelPassword = process.env.Redis__SentinelPassword || undefined;
const tls = process.env.Redis__Ssl?.toLowerCase() === "true";
const socket = { ...endpoints[0], tls };
const sentinelName = process.env.Redis__SentinelServiceName;
const client = sentinelName
  ? createSentinel({
      name: sentinelName,
      sentinelRootNodes: endpoints,
      nodeClientOptions: { username, password, socket: { tls } },
      sentinelClientOptions: { password: sentinelPassword, socket: { tls } },
    })
  : createClient({ username, password, socket });

client.on("error", () => undefined);
await client.connect();
try {
  if (action === "ping") {
    if (await client.ping() !== "PONG") throw new Error("Redis ping did not return PONG.");
  } else {
    const pattern = required("FULL_CIRCLE_PATTERN");
    let cursor = "0";
    do {
      const batch = await client.scan(cursor, { MATCH: pattern, COUNT: 100 });
      cursor = batch.cursor;
      if (batch.keys.length > 0) await client.unlink(batch.keys);
    } while (cursor !== "0");
  }
} finally {
  await client.close();
}
