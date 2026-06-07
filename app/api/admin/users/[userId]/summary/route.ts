import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSessionUserFromRequest, isAdminUser } from '@/lib/server-auth';
import { getUserSecurityEvents } from '@/lib/risk-control';

export async function GET(
  request: Request,
  context: { params: Promise<{ userId: string }> }
) {
  const sessionUser = await getSessionUserFromRequest(request);
  if (!isAdminUser(sessionUser)) {
    return NextResponse.json({ success: false, message: '无管理员权限' }, { status: 403 });
  }

  const { userId } = await context.params;
  const [user, pointLogs, orders, securityEvents] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        account: true,
        username: true,
        role: true,
        points: true,
        taskBlocked: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.pointLog.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        delta: true,
        reason: true,
        relatedId: true,
        balanceAfter: true,
        createdAt: true,
      },
    }),
    prisma.paymentOrder.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        orderNo: true,
        channel: true,
        amountFen: true,
        points: true,
        status: true,
        codeUrl: true,
        timeExpireAt: true,
        gatewayStatus: true,
        thirdTradeNo: true,
        paidAmountFen: true,
        paidAt: true,
        refundNo: true,
        refundAmountFen: true,
        refundStatus: true,
        refundedAt: true,
        createdAt: true,
      },
    }),
    getUserSecurityEvents(userId, 20),
  ]);

  if (!user) {
    return NextResponse.json({ success: false, message: '用户不存在' }, { status: 404 });
  }

  return NextResponse.json({
    success: true,
    data: {
      user,
      pointLogs,
      orders,
      securityEvents,
    },
  });
}
