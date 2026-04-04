import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

function getInternalSecret() {
  return process.env.INTERNAL_WORKER_SECRET || process.env.JWT_SECRET || 'dev-worker-secret';
}

export async function POST(request: Request) {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ success: false, message: '生产环境禁用 mock 支付' }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const orderNo = String(body.orderNo || '').trim();
  if (!orderNo) {
    return NextResponse.json({ success: false, message: '缺少订单号' }, { status: 400 });
  }

  const order = await prisma.paymentOrder.findUnique({ where: { orderNo } });
  if (!order) {
    return NextResponse.json({ success: false, message: '订单不存在' }, { status: 404 });
  }

  if (order.status === 'paid' || order.status === 'credited') {
    return NextResponse.json({ success: true, message: '已处理（幂等）' });
  }
  if (order.status !== 'pending') {
    return NextResponse.json({ success: false, message: `订单状态不允许入账: ${order.status}` }, { status: 409 });
  }

  const tradeNo = `MOCK_${Date.now()}`;
  const creditRes = await fetch(new URL('/api/pay/_internal/credit', request.url), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-worker-secret': getInternalSecret(),
    },
    body: JSON.stringify({
      orderNo: order.orderNo,
      thirdTradeNo: tradeNo,
      paidAmountFen: order.amountFen,
      payTime: new Date().toISOString(),
      rawNotify: { source: 'mock/mark-paid' },
    }),
  });

  const creditData = await creditRes.json().catch(() => ({}));
  if (!creditRes.ok || !creditData?.success) {
    return NextResponse.json(
      { success: false, message: creditData?.message || 'Mock 入账失败' },
      { status: 500 }
    );
  }

  return NextResponse.json({ success: true });
}
