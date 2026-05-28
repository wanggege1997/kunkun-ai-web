import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const LOCK_TTL_SEC = 45;

/**
 * 尝试获取分布式锁
 * 使用 Redis SET NX EX 原子操作，避免多实例竞争
 */
export async function acquireLock(key: string, owner: string): Promise<boolean> {
  const result = await redis.set(key, owner, {
    nx: true,       // 只在不存在时设置
    ex: LOCK_TTL_SEC,
  });
  return result === 'OK';
}

/**
 * 刷新锁的过期时间（持有者续期）
 */
export async function refreshLock(key: string, owner: string): Promise<void> {
  const current = await redis.get<string>(key);
  if (current === owner) {
    await redis.expire(key, LOCK_TTL_SEC);
  }
}

/**
 * 释放锁（只有持有者才能释放）
 */
export async function releaseLock(key: string, owner: string): Promise<void> {
  const current = await redis.get<string>(key);
  if (current === owner) {
    await redis.del(key);
  }
}
