import { randomBytes } from "node:crypto";

export async function connectWithDeadline(redisClient, timeoutMilliseconds) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error("Redis startup readiness deadline exceeded.");
      error.name = "StartupTimeoutError";
      reject(error);
    }, timeoutMilliseconds);
  });
  try {
    await Promise.race([redisClient.connect(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function closeFrame(masked) {
  const reason = Buffer.from("Going Away");
  const payload = Buffer.allocUnsafe(reason.length + 2);
  payload.writeUInt16BE(1001);
  reason.copy(payload, 2);
  if (!masked) return Buffer.concat([Buffer.from([0x88, payload.length]), payload]);
  const mask = randomBytes(4);
  const encoded = Buffer.from(payload);
  for (let index = 0; index < encoded.length; index += 1) encoded[index] ^= mask[index % 4];
  return Buffer.concat([Buffer.from([0x88, 0x80 | payload.length]), mask, encoded]);
}

function requestWebSocketClose(connection) {
  if (connection.browser?.writable && !connection.browser.destroyed) connection.browser.write(closeFrame(false));
  if (connection.gateway?.writable && !connection.gateway.destroyed) connection.gateway.write(closeFrame(true));
}

async function drainWebSockets(connections, timeoutMilliseconds) {
  if (connections.size === 0) return;
  for (const connection of connections) requestWebSocketClose(connection);
  await new Promise(resolve => {
    const interval = setInterval(() => {
      if (connections.size === 0) {
        clearInterval(interval);
        clearTimeout(deadline);
        resolve();
      }
    }, 10);
    const deadline = setTimeout(() => {
      clearInterval(interval);
      for (const connection of connections) {
        connection.browser?.destroy();
        connection.gateway?.destroy();
      }
      connections.clear();
      resolve();
    }, timeoutMilliseconds);
  });
}

export function createShutdown({ server, proxy, redisClient, upgradedSockets = new Set(), log, timeoutMilliseconds = 15_000, forceExit }) {
  let stopping = false;
  return async function stop(signal) {
    if (stopping) return;
    stopping = true;
    log({ event: "stopping", signal });
    const timeout = setTimeout(() => forceExit(1), timeoutMilliseconds + 1_000);
    timeout.unref?.();
    try {
      const serverClosed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      proxy.close();
      await Promise.all([serverClosed, drainWebSockets(upgradedSockets, timeoutMilliseconds)]);
      if (redisClient.isOpen) await redisClient.quit();
    } finally {
      clearTimeout(timeout);
    }
  };
}
