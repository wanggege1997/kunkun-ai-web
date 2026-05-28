import { redis } from '@/lib/redis-cache';

type RateLimitResult = {
  allowed: boolean;
  current: number;
  limit: number;
  retryAfterSec: number;
};

type CooldownResult = {
  allowed: boolean;
  retryAfterSec: number;
};

function normalizePart(value: string) {
  const trimmed = value.trim().toLowerCase();
  return trimmed || 'unknown';
}

export function getClientIpFromRequest(request: Request) {
  const xff = request.headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }

  const realIp = request.headers.get('x-real-ip');
  if (realIp?.trim()) return realIp.trim();

  return 'unknown';
}

export function buildSecurityKey(prefix: string, parts: string[]) {
  return [prefix, ...parts.map((part) => normalizePart(part))].join(':');
}

export async function consumeRateLimit(params: {
  key: string;
  limit: number;
  windowSec: number;
}): Promise<RateLimitResult> {
  const { key, limit, windowSec } = params;
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const bucket = Math.floor(nowSec / windowSec);
    const bucketKey = `${key}:${bucket}`;

    const current = await redis.incr(bucketKey);
    if (current === 1) {
      await redis.expire(bucketKey, windowSec + 2);
    }

    const retryAfterSec = Math.max(1, windowSec - (nowSec % windowSec));
    return {
      allowed: current <= limit,
      current,
      limit,
      retryAfterSec,
    };
  } catch {
    return {
      allowed: true,
      current: 0,
      limit,
      retryAfterSec: 0,
    };
  }
}

export async function checkCooldown(params: {
  key: string;
  cooldownSec: number;
}): Promise<CooldownResult> {
  const { key, cooldownSec } = params;
  try {
    const now = Date.now();

    const blockedUntil = await redis.get<number>(key);
    if (typeof blockedUntil === 'number' && blockedUntil > now) {
      return {
        allowed: false,
        retryAfterSec: Math.max(1, Math.ceil((blockedUntil - now) / 1000)),
      };
    }

    const nextAllowedAt = now + cooldownSec * 1000;
    await redis.set(key, nextAllowedAt, { ex: cooldownSec + 1 });

    return {
      allowed: true,
      retryAfterSec: 0,
    };
  } catch {
    return {
      allowed: true,
      retryAfterSec: 0,
    };
  }
}
