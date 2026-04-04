import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSessionUserFromRequest } from '@/lib/server-auth';

export async function GET(
  request: Request,
  context: { params: Promise<{ orderNo: string }> }
) {
  const user = await getSessionUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ success: false, message: '未登录' }, { status: 401 });
  }

  const { orderNo } = await context.params;
  const order = await prisma.paymentOrder.findFirst({
    where: {
      orderNo,
      userId: user.id,
    },
    select: {
      orderNo: true,
      channel: true,
      amountFen: true,
      points: true,
      status: true,
      thirdTradeNo: true,
      paidAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (!order) {
    return NextResponse.json({ success: false, message: '订单不存在' }, { status: 404 });
  }

  return NextResponse.json({ success: true, data: order });
}
