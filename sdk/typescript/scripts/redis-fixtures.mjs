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
const sentinelName = process.env.Redis__SentinelServiceName;
const clients = [];

if (sentinelName) {
  const client = createSentinel({
      name: sentinelName,
      sentinelRootNodes: endpoints,
      nodeClientOptions: { username, password, socket: { tls } },
      sentinelClientOptions: { password: sentinelPassword, socket: { tls } },
    });
  client.on("error", () => undefined);
  await client.connect();
  clients.push(client);
} else {
  for (const endpoint of endpoints) {
    const client = createClient({
      username,
      password,
      socket: { ...endpoint, tls, connectTimeout: 5_000, reconnectStrategy: false },
    });
    client.on("error", () => undefined);
    try {
      await client.connect();
      clients.push(client);
    } catch { /* Try the next configured direct endpoint. */ }
  }
  if (clients.length === 0) throw new Error("No configured Redis endpoint was reachable.");
}

try {
  if (action === "ping") {
    const results = await Promise.allSettled(clients.map(client => client.ping()));
    if (!results.some(result => result.status === "fulfilled" && result.value === "PONG")) {
      throw new Error("Redis ping did not return PONG.");
    }
  } else {
    const pattern = required("FULL_CIRCLE_PATTERN");
    for (const client of clients) {
      let cursor = "0";
      do {
        const batch = await client.scan(cursor, { MATCH: pattern, COUNT: 100 });
        cursor = batch.cursor;
        await Promise.all(batch.keys.map(key => client.unlink(key)));
      } while (cursor !== "0");
    }
  }
} finally {
  await Promise.all(clients.map(client => client.close()));
}
