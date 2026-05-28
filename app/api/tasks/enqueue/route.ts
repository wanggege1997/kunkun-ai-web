import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSessionUserFromRequest } from '@/lib/server-auth';
import { triggerServerQueueWorker } from '@/lib/queue-worker';
import { getGlobalStopEnabled } from '@/lib/points';
import { Prisma } from '@prisma/client';
import { invalidateCache, cacheKeys } from '@/lib/redis-cache';
import { buildSecurityKey, consumeRateLimit } from '@/lib/security';
import { SECURITY_POLICY } from '@/lib/security-config';
import { pushSecurityAudit, releaseExpiredAutoBlock } from '@/lib/risk-control';
import { getWorkflowPointCostById } from '@/lib/workflows';
import { buildWorkflowPrechargePointsMap, getQueueRuntimeConfig } from '@/lib/queue-config';

type EnqueueTask = {
  id?: string;
  requestId?: string;
  workflowId?: string;
  workflowTitle?: string;
  pointsCost?: number;
  payload?: unknown;
  createdAt?: number;
};

export async function POST(request: Request) {
  const user = await getSessionUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ success: false, message: '未登录' }, { status: 401 });
  }

  await releaseExpiredAutoBlock(user.id).catch(() => undefined);

  const latestUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: { id: true, account: true, points: true, taskBlocked: true },
  });
  if (!latestUser) {
    return NextResponse.json({ success: false, message: '用户不存在' }, { status: 404 });
  }

  if (latestUser.taskBlocked) {
    await pushSecurityAudit({
      userId: latestUser.id,
      account: latestUser.account,
      path: '/api/tasks/enqueue',
      action: 'enqueue_task',
      result: 'rejected',
      status: 403,
    });
    return NextResponse.json({ success: false, message: '当前账号任务已暂停，请联系管理员处理' }, { status: 403 });
  }

  const enqueueLimit = await consumeRateLimit({
    key: buildSecurityKey('rl:tasks:enqueue', [user.id]),
    limit: SECURITY_POLICY.queue.enqueue.limit,
    windowSec: SECURITY_POLICY.queue.enqueue.windowSec,
  });
  if (!enqueueLimit.allowed) {
    await pushSecurityAudit({
      userId: latestUser.id,
      account: latestUser.account,
      path: '/api/tasks/enqueue',
      action: 'enqueue_task',
      result: 'rejected',
      status: 429,
    });
    return NextResponse.json(
      { success: false, message: `提交过于频繁，请${enqueueLimit.retryAfterSec}秒后再试` },
      { status: 429 }
    );
  }

  const globalStopped = await getGlobalStopEnabled();
  if (globalStopped) {
    await pushSecurityAudit({
      userId: latestUser.id,
      account: latestUser.account,
      path: '/api/tasks/enqueue',
      action: 'enqueue_task',
      result: 'rejected',
      status: 503,
    });
    return NextResponse.json({ success: false, message: '系统已开启全局紧急停机，请稍后重试' }, { status: 503 });
  }

  const body = await request.json().catch(() => ({}));
  const tasks = Array.isArray(body.tasks) ? (body.tasks as EnqueueTask[]) : [];
  if (tasks.length === 0) {
    return NextResponse.json({ success: false, message: '缺少任务数据' }, { status: 400 });
  }

  const valid = tasks.filter((task) => task.workflowId && String(task.requestId || '').trim() && task.payload);
  if (valid.length === 0) {
    return NextResponse.json({ success: false, message: '任务参数不完整' }, { status: 400 });
  }

  // 每用户最多同时排队 30 个任务，防止单用户占满队列
  const MAX_USER_QUEUE = 30;
  const userQueueCount = await prisma.taskRecord.count({
    where: { userId: latestUser.id, status: { in: ['queueing', 'submitting', 'running'] }, hiddenAt: null },
  });
  if (userQueueCount >= MAX_USER_QUEUE) {
    return NextResponse.json(
      { success: false, message: `当前排队任务已达上限（${MAX_USER_QUEUE}个），请等待任务完成后再提交` },
      { status: 429 }
    );
  }

  let created = 0;
  let duplicated = 0;
  let insufficientPoints = 0;
  let insufficientRequiredPoints = 0;
  let insufficientCurrentPoints = 0;
  let rejectedByQueueLimit = 0;
  let currentQueueCount = userQueueCount;
  let latestPoints = Number(latestUser.points || 0);
  const queueRuntimeConfig = await getQueueRuntimeConfig();
  const livePrechargePointsMap = buildWorkflowPrechargePointsMap(queueRuntimeConfig);

  for (const task of valid) {
    if (currentQueueCount >= MAX_USER_QUEUE) {
      rejectedByQueueLimit += 1;
      continue;
    }

    const requestId = String(task.requestId || '').trim();
    const workflowId = String(task.workflowId || '').trim();
    const workflowTitle = String(task.workflowTitle || '').trim() || workflowId;
    const pointsCost = Math.max(
      0,
      Number(
        livePrechargePointsMap[workflowId] != null
          ? livePrechargePointsMap[workflowId]
          : getWorkflowPointCostById(workflowId)
      )
    );
    const taskId = String(task.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

    try {
      const transactionResult = await prisma.$transaction(async (tx) => {
        const existing = await tx.taskRecord.findUnique({
          where: {
            userId_requestId: {
              userId: latestUser.id,
              requestId,
            },
          },
          select: { id: true },
        });

        if (existing) {
          return { created: false as const, duplicated: true as const, points: latestPoints };
        }

        let nextPoints = latestPoints;

        if (pointsCost > 0) {
          const account = await tx.user.findUnique({
            where: { id: latestUser.id },
            select: { points: true },
          });

          if (!account) {
            throw new Error('用户不存在');
          }

          if (account.points < pointsCost) {
            if (insufficientRequiredPoints === 0) {
              insufficientRequiredPoints = pointsCost;
              insufficientCurrentPoints = account.points;
            }
            throw new Error('积分不足');
          }

          nextPoints = account.points - pointsCost;

          const updated = await tx.user.update({
            where: { id: latestUser.id },
            data: { points: nextPoints },
            select: { points: true },
          });
          nextPoints = updated.points;

          await tx.pointLog.create({
            data: {
              userId: latestUser.id,
              delta: -pointsCost,
              reason: `任务积分预占：${workflowTitle}`,
              relatedId: taskId,
              balanceAfter: nextPoints,
            },
          });
        }

        await tx.taskRecord.create({
          data: {
            id: taskId,
            userId: latestUser.id,
            requestId,
            workflowId,
            workflowTitle,
            status: 'queueing',
            pointsCost,
            pointState: pointsCost > 0 ? 'reserved' : 'none',
            pointReservedAt: pointsCost > 0 ? new Date() : null,
            payloadJson: JSON.stringify(task.payload),
            createdAt: new Date(Number(task.createdAt || Date.now())),
          },
        });

        return { created: true as const, duplicated: false as const, points: nextPoints };
      });

      if (transactionResult.duplicated) {
        duplicated += 1;
        continue;
      }

      if (transactionResult.created) {
        created += 1;
        currentQueueCount += 1;
        latestPoints = transactionResult.points;
      }
    } catch (error: unknown) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        duplicated += 1;
        continue;
      }

      if (error instanceof Error && error.message === '积分不足') {
        insufficientPoints += 1;
        continue;
      }

      throw error;
    }
  }

  if (created > 0) {
    await invalidateCache(cacheKeys.user(latestUser.id), cacheKeys.pointLedger(latestUser.id));
    await pushSecurityAudit({
      userId: latestUser.id,
      account: latestUser.account,
      path: '/api/tasks/enqueue',
      action: 'enqueue_task',
      result: 'success',
      status: 200,
    });
    void triggerServerQueueWorker();
  }

  return NextResponse.json({
    success: true,
    data: {
      queued: created,
      duplicated,
      insufficientPoints,
      insufficientRequiredPoints,
      insufficientCurrentPoints,
      rejectedByQueueLimit,
      points: latestPoints,
    },
  });
}
