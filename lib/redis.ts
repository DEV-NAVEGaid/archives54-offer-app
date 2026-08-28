import { Redis } from "@upstash/redis";

export class RedisUnavailableError extends Error {
  constructor() {
    super("Redis unavailable");
    this.name = "RedisUnavailableError";
  }
}

// ponytail: lazy init so build-time page-data collection doesn't instantiate Redis
let _redis: Redis | undefined;

export function getRedis(): Redis {
  if (!_redis) {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) {
      throw new RedisUnavailableError();
    }
    _redis = new Redis({ url, token });
  }
  return _redis;
}

// ponytail: proxy keeps `import { redis }` working while deferring construction to first use
export const redis: Redis = new Proxy({} as Redis, {
  get(_, prop) {
    const instance = getRedis();
    const value = Reflect.get(instance, prop);
    return typeof value === "function" ? value.bind(instance) : value;
  },
});

// Optional caches bypass this and swallow errors locally instead.
export async function withRedis<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    console.error("[Archive54] Redis unavailable:", e);
    throw new RedisUnavailableError();
  }
}
