import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSessionUserFromRequest, isAdminUser } from '@/lib/server-auth';

export async function GET(request: Request) {
  const sessionUser = await getSessionUserFromRequest(request);
  if (!isAdminUser(sessionUser)) {
    return NextResponse.json({ success: false, message: '无管理员权限' }, { status: 403 });
  }

  const statusGroups = await prisma.taskRecord.groupBy({
    by: ['status'],
    _count: { status: true },
  });

  const total = statusGroups.reduce((sum, g) => sum + g._count.status, 0);
  const success = statusGroups.find((g) => g.status === 'success')?._count.status || 0;
  const failed = statusGroups
    .filter((g) => ['failed', 'timeout'].includes(g.status))
    .reduce((sum, g) => sum + g._count.status, 0);

  const recent = await prisma.taskRecord.findMany({
    orderBy: { createdAt: 'desc' },
    take: 1000,
    include: {
      user: {
        select: { account: true },
      },
    },
  });

  const userCounter = new Map<string, number>();
  for (const row of recent) {
    const account = row.user.account;
    userCounter.set(account, (userCounter.get(account) || 0) + 1);
  }

  const topUsers = Array.from(userCounter.entries())
    .map(([account, count]) => ({ account, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const deliveryFailed = await prisma.taskRecord.count({
    where: {
      status: 'success',
      deliveryStatus: 'failed',
    },
  });

  return NextResponse.json({
    success: true,
    data: {
      total,
      success,
      failed,
      deliveryFailed,
      successRate: total > 0 ? Number(((success / total) * 100).toFixed(2)) : 0,
      statusGroups: statusGroups.map((g) => ({ status: g.status, count: g._count.status })),
      topUsers,
    },
  });
}
