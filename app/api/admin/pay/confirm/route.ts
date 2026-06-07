import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSessionUserFromRequest, isAdminUser } from '@/lib/server-auth';
import { creditPaymentOrder } from '@/lib/payment-service';

export async function POST(request: Request) {
  const sessionUser = await getSessionUserFromRequest(request);
  if (!isAdminUser(sessionUser)) {
    return NextResponse.json({ success: false, message: '无管理员权限' }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const orderNo = String(body.orderNo || '').trim();
  const note = String(body.note || '').trim() || '管理员手动确认支付';

  if (!orderNo) {
    return NextResponse.json({ success: false, message: '缺少订单号' }, { status: 400 });
  }

  const order = await prisma.paymentOrder.findUnique({
    where: { orderNo },
    select: { amountFen: true },
  });
  if (!order) {
    return NextResponse.json({ success: false, message: '订单不存在' }, { status: 404 });
  }

  try {
    const result = await creditPaymentOrder({
      orderNo,
      paidAmountFen: order.amountFen,
      thirdTradeNo: `MANUAL-${sessionUser.id}-${Date.now()}`,
      paidAt: new Date(),
      rawNotify: { source: 'admin-confirm', note },
    });

    return NextResponse.json({
      success: true,
      message: result.credited ? '支付确认成功，积分已到账' : '订单已处理（幂等）',
      data: {
        orderNo,
        status: 'credited',
        confirmedBy: sessionUser.id,
        confirmedAt: new Date().toISOString(),
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : '支付确认失败';
    const status = message.includes('不允许入账') ? 409 : 400;
    return NextResponse.json({ success: false, message }, { status });
  }
}
