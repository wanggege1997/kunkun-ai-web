import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSessionUserFromRequest } from '@/lib/server-auth';
import { closePaymentOrder } from '@/lib/payment-service';

export async function POST(
  request: Request,
  context: { params: Promise<{ orderNo: string }> }
) {
  const user = await getSessionUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ success: false, message: '未登录' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const reason = String(body?.reason || '').trim() || 'user_cancel';
  const { orderNo } = await context.params;

  const order = await prisma.paymentOrder.findFirst({
    where: {
      orderNo,
      userId: user.id,
    },
    select: { orderNo: true },
  });
  if (!order) {
    return NextResponse.json({ success: false, message: '订单不存在' }, { status: 404 });
  }

  try {
    const result = await closePaymentOrder(order.orderNo);
    return NextResponse.json({
      success: true,
      data: {
        orderNo,
        status: result.order?.status || 'closed',
        reason,
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : '关闭订单失败';
    return NextResponse.json({ success: false, message }, { status: 409 });
  }
}
