import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSessionUserFromRequest } from '@/lib/server-auth';
import { withCache, cacheKeys } from '@/lib/redis-cache';

function maskPointLogReason(raw: string): string {
  const reason = String(raw || '');

  if (reason.includes('任务积分预占')) return '任务预扣积分';
  if (reason.includes('任务失败释放预占积分')) return '任务失败，返还预扣积分';
  if (reason.includes('任务终态补偿释放')) return '任务状态修正，返还预扣积分';
  if (reason.includes('应用下架释放预占积分')) return '应用不可用，返还预扣积分';
  if (reason.includes('运行中取消结算')) return '任务取消，按规则返还积分';

  // 兜底：凡是包含成本/结算细节的文案全部脱敏
  if (
    reason.includes('成本来源') ||
    reason.includes('估算成本') ||
    reason.includes('实扣') ||
    reason.includes('退款') ||
    reason.includes('结算')
  ) {
    return '任务结算处理';
  }

  return reason;
}

export async function GET(request: Request) {
  try {
    const user = await getSessionUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ success: false, message: '未登录' }, { status: 401 });
    }

    const keepAfter = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);

    const logs = await withCache(
      cacheKeys.pointLedger(user.id),
      60, // 60秒缓存
      () => prisma.pointLog.findMany({
        where: { userId: user.id, createdAt: { gte: keepAfter } },
        orderBy: { createdAt: 'desc' },
        take: 200,
      })
    );

    const sanitized = logs.map((item) => ({
      ...item,
      reason: maskPointLogReason(item.reason),
    }));

    return NextResponse.json({ success: true, data: sanitized });
  } catch {
    return NextResponse.json({ success: false, message: '查询积分流水失败' }, { status: 500 });
  }
}
