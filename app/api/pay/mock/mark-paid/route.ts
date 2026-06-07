import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { creditPaymentOrder } from '@/lib/payment-service';

export async function POST(request: Request) {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ success: false, message: '生产环境禁用 mock 支付' }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const orderNo = String(body.orderNo || '').trim();
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

  const tradeNo = `MOCK_${Date.now()}`;
  try {
    const result = await creditPaymentOrder({
      orderNo,
      thirdTradeNo: tradeNo,
      paidAmountFen: order.amountFen,
      paidAt: new Date(),
      rawNotify: { source: 'mock/mark-paid' },
    });

    return NextResponse.json({
      success: true,
      message: result.credited ? '已入账' : '已处理（幂等）',
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Mock 入账失败';
    return NextResponse.json({ success: false, message }, { status: 500 });
  }
}
