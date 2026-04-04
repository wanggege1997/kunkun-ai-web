import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSessionUserFromRequest } from '@/lib/server-auth';

export async function GET(request: Request) {
  try {
    const user = await getSessionUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ success: false, message: '未登录' }, { status: 401 });
    }

    const keepAfter = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);

    const logs = await prisma.pointLog.findMany({
      where: {
        userId: user.id,
        createdAt: { gte: keepAfter },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    return NextResponse.json({ success: true, data: logs });
  } catch {
    return NextResponse.json({ success: false, message: '查询积分流水失败' }, { status: 500 });
  }
}
