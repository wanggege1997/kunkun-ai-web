import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

export { redis };

/**
 * 读缓存，没有则执行 fetcher 并写入缓存
 */
export async function withCache<T>(
  key: string,
  ttlSec: number,
  fetcher: () => Promise<T>
): Promise<T> {
  const cached = await redis.get<T>(key);
  if (cached !== null && cached !== undefined) return cached;
  const data = await fetcher();
  await redis.set(key, data, { ex: ttlSec });
  return data;
}

/** 删除缓存（数据变更时调用） */
export async function invalidateCache(...keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await redis.del(...keys);
}

/** 用户相关缓存 key */
export const cacheKeys = {
  user: (userId: string) => `user:${userId}`,
  userTasks: (userId: string) => `user_tasks:${userId}`,
  pointLedger: (userId: string) => `point_ledger:${userId}`,
};
