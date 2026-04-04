import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSessionUserFromRequest } from '@/lib/server-auth';

function mapGatewayStatus(channel: string, status: string) {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'pending') return channel === 'wechat' ? 'NOTPAY' : 'WAIT_BUYER_PAY';
  if (normalized === 'paid' || normalized === 'credited') return channel === 'wechat' ? 'SUCCESS' : 'TRADE_SUCCESS';
  if (normalized === 'closed') return channel === 'wechat' ? 'CLOSED' : 'TRADE_CLOSED';
  if (normalized === 'failed') return channel === 'wechat' ? 'PAYERROR' : 'TRADE_FAILED';
  return 'UNKNOWN';
}

export async function POST(
  request: Request,
  context: { params: Promise<{ orderNo: string }> }
) {
  const user = await getSessionUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ success: false, message: '未登录' }, { status: 401 });
  }

  const { orderNo } = await context.params;
  const idempotencyKey = request.headers.get('idempotency-key') || '';

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

  return NextResponse.json({
    success: true,
    data: {
      ...order,
      gatewayStatus: mapGatewayStatus(order.channel, order.status),
      queriedAt: new Date().toISOString(),
      idempotencyKey: idempotencyKey || null,
    },
  });
}
