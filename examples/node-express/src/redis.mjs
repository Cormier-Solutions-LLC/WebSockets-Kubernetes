export const redisCommandTimeoutMilliseconds = 5_000;

export function createRedisOptions(url) {
  return {
    url,
    commandOptions: { timeout: redisCommandTimeoutMilliseconds },
  };
}
