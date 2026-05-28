import { prisma } from '@/lib/prisma';
import { redis } from '@/lib/redis-cache';

export type SecurityEventType =
  | 'login_fail_burst'
  | 'login_rate_limited'
  | 'task_failure_streak'
  | 'task_auto_blocked'
  | 'task_auto_unblocked'
  | 'manual_block_changed';

export type SecurityEvent = {
  id: string;
  type: SecurityEventType;
  userId?: string;
  account?: string;
  ip?: string;
  detail: string;
  route?: string;
  createdAt: number;
};

export type SecurityAuditEvent = {
  id: string;
  userId?: string;
  account?: string;
  ip?: string;
  path: string;
  action: string;
  result: 'success' | 'rejected' | 'failed';
  status: number;
  requestId?: string;
  createdAt: number;
};

const SECURITY_EVENTS_KEY = 'security:events:v1';
const SECURITY_AUDIT_KEY = 'security:audit:v1';
const LOGIN_FAIL_STREAK_PREFIX = 'risk:login:streak';
const TASK_FAIL_STREAK_PREFIX = 'risk:task:streak';
const AUTO_BLOCK_KEY_PREFIX = 'auto_block_user_';
const MAX_SECURITY_EVENTS = 300;
const MAX_SECURITY_AUDIT = 500;

export const RISK_POLICY = {
  loginFailBurstThreshold: 5,
  loginFailBurstWindowSec: 15 * 60,
  taskFailureThreshold: 3,
  taskFailureWindowSec: 30 * 60,
  taskAutoBlockSec: 15 * 60,
} as const;

function createEventId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function buildAutoBlockKey(userId: string) {
  return `${AUTO_BLOCK_KEY_PREFIX}${userId}`;
}

export async function pushSecurityEvent(input: Omit<SecurityEvent, 'id' | 'createdAt'>) {
  const event: SecurityEvent = {
    id: createEventId(),
    createdAt: Date.now(),
    ...input,
  };

  try {
    await redis.lpush(SECURITY_EVENTS_KEY, JSON.stringify(event));
    await redis.ltrim(SECURITY_EVENTS_KEY, 0, MAX_SECURITY_EVENTS - 1);
  } catch {
    // ignore
  }

  return event;
}

export async function pushSecurityAudit(input: Omit<SecurityAuditEvent, 'id' | 'createdAt'>) {
  const event: SecurityAuditEvent = {
    id: createEventId(),
    createdAt: Date.now(),
    ...input,
  };

  try {
    await redis.lpush(SECURITY_AUDIT_KEY, JSON.stringify(event));
    await redis.ltrim(SECURITY_AUDIT_KEY, 0, MAX_SECURITY_AUDIT - 1);
  } catch {
    // ignore
  }

  return event;
}

export async function getSecurityAuditEvents(limit = 50, actionFilter?: string) {
  try {
    const rows = await redis.lrange<string>(SECURITY_AUDIT_KEY, 0, Math.max(0, limit * 6 - 1));
    const list = (rows || [])
      .map((row) => {
        try {
          return JSON.parse(String(row)) as SecurityAuditEvent;
        } catch {
          return null;
        }
      })
      .filter((item): item is SecurityAuditEvent => Boolean(item));

    const filtered = actionFilter
      ? list.filter((item) => String(item.action || '') === actionFilter)
      : list;

    return filtered.slice(0, limit);
  } catch {
    return [] as SecurityAuditEvent[];
  }
}

export async function getUserSecurityEvents(userId: string, limit = 20) {
  try {
    const rows = await redis.lrange<string>(SECURITY_EVENTS_KEY, 0, Math.max(0, limit * 5 - 1));
    const events = (rows || [])
      .map((row) => {
        try {
          return JSON.parse(String(row)) as SecurityEvent;
        } catch {
          return null;
        }
      })
      .filter((item): item is SecurityEvent => Boolean(item && item.userId === userId))
      .slice(0, limit);
    return events;
  } catch {
    return [] as SecurityEvent[];
  }
}

export async function registerLoginFailure(params: { ip: string; account: string; route: string }) {
  const { ip, account, route } = params;
  const key = `${LOGIN_FAIL_STREAK_PREFIX}:${ip}:${account || 'unknown'}`;
  try {
    const streak = await redis.incr(key);
    if (streak === 1) {
      await redis.expire(key, RISK_POLICY.loginFailBurstWindowSec + 2);
    }

    if (streak >= RISK_POLICY.loginFailBurstThreshold) {
      await pushSecurityEvent({
        type: 'login_fail_burst',
        account,
        ip,
        route,
        detail: `登录失败突增：${RISK_POLICY.loginFailBurstWindowSec / 60}分钟内累计失败 ${streak} 次`,
      });
    }

    return streak;
  } catch {
    return 0;
  }
}

export async function resetLoginFailure(params: { ip: string; account: string }) {
  const { ip, account } = params;
  const key = `${LOGIN_FAIL_STREAK_PREFIX}:${ip}:${account || 'unknown'}`;
  await redis.del(key).catch(() => undefined);
}

export async function reportLoginRateLimited(params: { ip: string; account: string; retryAfterSec: number }) {
  const { ip, account, retryAfterSec } = params;
  await pushSecurityEvent({
    type: 'login_rate_limited',
    ip,
    account,
    detail: `登录接口触发限流，需等待 ${retryAfterSec} 秒`,
    route: '/api/auth/login-password',
  });
}

export async function clearTaskFailureStreak(userId: string) {
  const key = `${TASK_FAIL_STREAK_PREFIX}:${userId}`;
  await redis.del(key).catch(() => undefined);
}

export async function clearUserAutoBlock(userId: string) {
  await prisma.systemSetting.delete({ where: { key: buildAutoBlockKey(userId) } }).catch(() => undefined);
}

export async function applyTaskFailureRiskControl(params: {
  userId: string;
  account?: string;
  reason: string;
  workflowId?: string;
}) {
  const { userId, account, reason, workflowId } = params;
  const key = `${TASK_FAIL_STREAK_PREFIX}:${userId}`;

  let streak = 0;
  try {
    streak = await redis.incr(key);
    if (streak === 1) {
      await redis.expire(key, RISK_POLICY.taskFailureWindowSec + 2);
    }
  } catch {
    return { streak: 0, blocked: false };
  }

  await pushSecurityEvent({
    type: 'task_failure_streak',
    userId,
    account,
    detail: `任务连续失败累计 ${streak} 次，最近原因：${reason}${workflowId ? `，应用：${workflowId}` : ''}`,
    route: '/api/tasks/enqueue',
  });

  if (streak < RISK_POLICY.taskFailureThreshold) {
    return { streak, blocked: false };
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, taskBlocked: true, account: true },
  });

  if (!user || user.role === 'admin') {
    return { streak, blocked: false };
  }

  const blockedUntil = Date.now() + RISK_POLICY.taskAutoBlockSec * 1000;

  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { taskBlocked: true } });
    await tx.systemSetting.upsert({
      where: { key: buildAutoBlockKey(userId) },
      create: {
        key: buildAutoBlockKey(userId),
        value: JSON.stringify({
          blockedUntil,
          blockedAt: Date.now(),
          reason: 'consecutive_task_failures',
          streak,
        }),
      },
      update: {
        value: JSON.stringify({
          blockedUntil,
          blockedAt: Date.now(),
          reason: 'consecutive_task_failures',
          streak,
        }),
      },
    });
  });

  await pushSecurityEvent({
    type: 'task_auto_blocked',
    userId,
    account: user.account,
    detail: `连续失败达到阈值，已自动暂停任务 ${RISK_POLICY.taskAutoBlockSec / 60} 分钟（不包含用户主动取消）`,
    route: '/api/tasks/enqueue',
  });

  return { streak, blocked: true, blockedUntil };
}

export async function releaseExpiredAutoBlock(userId: string) {
  const key = buildAutoBlockKey(userId);
  const state = await prisma.systemSetting.findUnique({ where: { key } });
  if (!state) return { released: false };

  let blockedUntil = 0;
  try {
    const parsed = JSON.parse(state.value) as { blockedUntil?: number };
    blockedUntil = Number(parsed.blockedUntil || 0);
  } catch {
    blockedUntil = 0;
  }

  if (!blockedUntil || blockedUntil > Date.now()) {
    return { released: false, blockedUntil };
  }

  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { taskBlocked: false } });
    await tx.systemSetting.delete({ where: { key } });
  });

  await clearTaskFailureStreak(userId);
  await pushSecurityEvent({
    type: 'task_auto_unblocked',
    userId,
    detail: '自动封禁到期，已恢复任务提交权限',
    route: '/api/tasks/enqueue',
  });

  return { released: true, blockedUntil: 0 };
}
