import { prisma } from '@/lib/prisma';
import { invalidateCache, cacheKeys } from '@/lib/redis-cache';
import { pushSecurityAudit } from '@/lib/risk-control';

export type TaskPointState = 'none' | 'reserved' | 'captured' | 'released';

type FinalizeTaskPointsInput = {
  taskId: string;
  mode: 'capture' | 'release';
  reason?: string;
  releasePoints?: number;
  expectedPointsCost?: number;
};

type BaselineMismatchMeta = {
  userId: string;
  workflowTitle: string;
  expected: number;
  actual: number;
  mode: 'capture' | 'release';
};

type ChangePointsInput = {
  userId: string;
  delta: number;
  reason: string;
  relatedId?: string;
  operatorId?: string;
  allowNegative?: boolean;
};

export async function changeUserPoints(input: ChangePointsInput) {
  const {
    userId,
    delta,
    reason,
    relatedId,
    operatorId,
    allowNegative = false,
  } = input;

  if (!Number.isInteger(delta) || delta === 0) {
    throw new Error('积分变更值必须是非零整数');
  }

  const result = await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { id: true, points: true },
    });

    if (!user) {
      throw new Error('用户不存在');
    }

    const next = user.points + delta;
    if (!allowNegative && next < 0) {
      throw new Error('积分不足');
    }

    const updated = await tx.user.update({
      where: { id: userId },
      data: { points: next },
      select: { id: true, points: true },
    });

    const log = await tx.pointLog.create({
      data: {
        userId,
        delta,
        reason,
        relatedId: relatedId || null,
        operatorId: operatorId || null,
        balanceAfter: updated.points,
      },
    });

    return {
      userId: updated.id,
      points: updated.points,
      log,
    };
  });

  // 积分变更后失效用户缓存和流水缓存
  await invalidateCache(cacheKeys.user(userId), cacheKeys.pointLedger(userId));

  return result;
}

export async function getGlobalStopEnabled() {
  const row = await prisma.systemSetting.findUnique({ where: { key: 'global_task_stop' } });
  return row?.value === '1';
}

export async function setGlobalStopEnabled(enabled: boolean) {
  await prisma.systemSetting.upsert({
    where: { key: 'global_task_stop' },
    create: { key: 'global_task_stop', value: enabled ? '1' : '0' },
    update: { value: enabled ? '1' : '0' },
  });
}

export async function finalizeTaskPoints(input: FinalizeTaskPointsInput) {
  const { taskId, mode, reason, expectedPointsCost } = input;
  if (!taskId) {
    throw new Error('缺少任务ID');
  }

  let affectedUserId = '';
  let baselineMismatchMeta: BaselineMismatchMeta | null = null;

  let result:
    | {
        taskId: string;
        userId: string;
        pointState: TaskPointState;
        changed: boolean;
        releasedPoints?: number;
      }
    | undefined;

  try {
    result = await prisma.$transaction(async (tx) => {
      const task = await tx.taskRecord.findUnique({
        where: { id: taskId },
        select: {
          id: true,
          userId: true,
          workflowTitle: true,
          pointsCost: true,
          pointState: true,
        },
      });

      if (!task) {
        throw new Error('任务不存在');
      }

      affectedUserId = task.userId;

      const pointState = String(task.pointState || 'none') as TaskPointState;
      const pointsCost = Math.max(0, Number(task.pointsCost || 0));

      if (Number.isFinite(Number(expectedPointsCost))) {
        const expected = Math.max(0, Math.floor(Number(expectedPointsCost)));
        if (expected !== pointsCost) {
          baselineMismatchMeta = {
            userId: task.userId,
            workflowTitle: task.workflowTitle,
            expected,
            actual: pointsCost,
            mode,
          };
          throw new Error(`积分基准不一致：expected=${expected}, actual=${pointsCost}`);
        }
      }

      if (pointsCost <= 0 || pointState === 'none') {
        return {
          taskId: task.id,
          userId: task.userId,
          pointState,
          changed: false,
        };
      }

    if (mode === 'capture') {
      if (pointState !== 'reserved') {
        return {
          taskId: task.id,
          userId: task.userId,
          pointState,
          changed: false,
        };
      }

      await tx.taskRecord.update({
        where: { id: task.id },
        data: {
          pointState: 'captured',
          pointCapturedAt: new Date(),
        },
      });

      return {
        taskId: task.id,
        userId: task.userId,
        pointState: 'captured' as TaskPointState,
        changed: true,
      };
    }

    if (pointState !== 'reserved') {
      return {
        taskId: task.id,
        userId: task.userId,
        pointState,
        changed: false,
      };
    }

    const releasePointsRaw = input.releasePoints;
    const releasePointsNormalized = Number.isFinite(Number(releasePointsRaw))
      ? Math.floor(Number(releasePointsRaw))
      : pointsCost;
    const releasePoints = Math.min(pointsCost, Math.max(0, releasePointsNormalized));

    if (releasePoints <= 0) {
      await tx.taskRecord.update({
        where: { id: task.id },
        data: {
          pointState: 'captured',
          pointCapturedAt: new Date(),
        },
      });

      return {
        taskId: task.id,
        userId: task.userId,
        pointState: 'captured' as TaskPointState,
        changed: true,
        releasedPoints: 0,
      };
    }

    const user = await tx.user.findUnique({
      where: { id: task.userId },
      select: { id: true, points: true },
    });

    if (!user) {
      throw new Error('用户不存在');
    }

    const nextPoints = user.points + releasePoints;

    const updated = await tx.user.update({
      where: { id: task.userId },
      data: { points: nextPoints },
      select: { points: true },
    });

    await tx.pointLog.create({
      data: {
        userId: task.userId,
        delta: releasePoints,
        reason: reason || `任务积分释放：${task.workflowTitle}`,
        relatedId: task.id,
        balanceAfter: updated.points,
      },
    });

    await tx.taskRecord.update({
      where: { id: task.id },
      data: {
        pointState: 'released',
        pointReleasedAt: new Date(),
      },
    });

    return {
      taskId: task.id,
      userId: task.userId,
      pointState: 'released' as TaskPointState,
      changed: true,
      releasedPoints: releasePoints,
    };
    });
  } catch (error) {
    const mismatchMeta = baselineMismatchMeta as BaselineMismatchMeta | null;
    if (mismatchMeta) {
      const user = await prisma.user.findUnique({
        where: { id: mismatchMeta.userId },
        select: { account: true },
      }).catch(() => null);
      await pushSecurityAudit({
        userId: mismatchMeta.userId,
        account: user?.account,
        path: '/lib/points.finalizeTaskPoints',
        action: 'points_baseline_mismatch',
        result: 'rejected',
        status: 409,
      }).catch(() => undefined);
    }
    throw error;
  }

  if (affectedUserId) {
    await invalidateCache(cacheKeys.user(affectedUserId), cacheKeys.pointLedger(affectedUserId));
  }

  return result!;
}
