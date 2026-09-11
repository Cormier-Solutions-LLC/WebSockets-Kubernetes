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

export function createShutdown({ server, proxy, redisClient, log, timeoutMilliseconds = 15_000, forceExit }) {
  let stopping = false;
  return async function stop(signal) {
    if (stopping) return;
    stopping = true;
    log({ event: "stopping", signal });
    const timeout = setTimeout(() => forceExit(1), timeoutMilliseconds);
    timeout.unref?.();
    try {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      proxy.close();
      if (redisClient.isOpen) await redisClient.quit();
    } finally {
      clearTimeout(timeout);
    }
  };
}
