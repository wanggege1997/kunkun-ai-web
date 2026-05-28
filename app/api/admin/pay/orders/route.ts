import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSessionUserFromRequest, isAdminUser } from '@/lib/server-auth';

/**
 * GET /api/admin/pay/orders
 * 管理员查询支付订单列表
 * Query: status?, userId?, page?, pageSize?
 */
export async function GET(request: Request) {
  const sessionUser = await getSessionUserFromRequest(request);
  if (!isAdminUser(sessionUser)) {
    return NextResponse.json({ success: false, message: '无管理员权限' }, { status: 403 });
  }

  const url = new URL(request.url);
  const status = url.searchParams.get('status') || undefined;
  const userId = url.searchParams.get('userId') || undefined;
  const page = Math.max(1, Number(url.searchParams.get('page') || 1));
  const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('pageSize') || 20)));

  const where = {
    ...(status ? { status } : {}),
    ...(userId ? { userId } : {}),
  };

  const [total, orders] = await Promise.all([
    prisma.paymentOrder.count({ where }),
    prisma.paymentOrder.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        user: { select: { account: true, username: true } },
      },
    }),
  ]);

  return NextResponse.json({
    success: true,
    data: {
      total,
      page,
      pageSize,
      orders: orders.map((o) => ({
        orderNo: o.orderNo,
        userId: o.userId,
        account: o.user.account,
        username: o.user.username,
        channel: o.channel,
        amountFen: o.amountFen,
        amountYuan: (o.amountFen / 100).toFixed(2),
        points: o.points,
        status: o.status,
        paidAt: o.paidAt,
        createdAt: o.createdAt,
        thirdTradeNo: o.thirdTradeNo,
      })),
    },
  });
}
