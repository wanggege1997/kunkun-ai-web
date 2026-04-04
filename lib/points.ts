import { prisma } from '@/lib/prisma';

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

  return prisma.$transaction(async (tx) => {
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
