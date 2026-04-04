import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getAlipayNotifySecret, verifyPayloadSignature } from '@/lib/payment';

function getInternalSecret() {
  return process.env.INTERNAL_WORKER_SECRET || process.env.JWT_SECRET || 'dev-worker-secret';
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const payload = {
    orderNo: String(body.orderNo || ''),
    tradeNo: String(body.tradeNo || ''),
    amountFen: Number(body.amountFen || 0),
    tradeStatus: String(body.tradeStatus || ''),
    ts: String(body.ts || ''),
  };
  const signature = String(body.signature || '');

  const secret = getAlipayNotifySecret();
  if (!secret) {
    return NextResponse.json({ success: false, message: 'ALIPAY_NOTIFY_SECRET 未配置' }, { status: 500 });
  }

  if (!verifyPayloadSignature(payload, signature, secret)) {
    return NextResponse.json({ success: false, message: '签名校验失败' }, { status: 401 });
  }

  if (payload.tradeStatus !== 'TRADE_SUCCESS') {
    return NextResponse.json({ success: true, message: '忽略非支付成功通知' });
  }

  const order = await prisma.paymentOrder.findUnique({ where: { orderNo: payload.orderNo } });
  if (!order) {
    return NextResponse.json({ success: false, message: '订单不存在' }, { status: 404 });
  }

  if (order.channel !== 'alipay') {
    return NextResponse.json({ success: false, message: '渠道不匹配' }, { status: 400 });
  }

  if (order.amountFen !== payload.amountFen) {
    return NextResponse.json({ success: false, message: '金额校验失败' }, { status: 400 });
  }

  if (order.status === 'paid') {
    return NextResponse.json({ success: true, message: '已处理（幂等）' });
  }

  if (order.status !== 'pending') {
    return NextResponse.json({ success: false, message: `订单状态不允许入账: ${order.status}` }, { status: 409 });
  }

  const creditRes = await fetch(new URL('/api/pay/_internal/credit', request.url), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-worker-secret': getInternalSecret(),
    },
    body: JSON.stringify({
      orderNo: order.orderNo,
      thirdTradeNo: payload.tradeNo,
      paidAmountFen: payload.amountFen,
      payTime: payload.ts || new Date().toISOString(),
      rawNotify: body,
    }),
  });

  const creditData = await creditRes.json().catch(() => ({}));
  if (!creditRes.ok || !creditData?.success) {
    return NextResponse.json(
      { success: false, message: creditData?.message || '入账失败，请稍后重试' },
      { status: 500 }
    );
  }

  return NextResponse.json({ success: true, message: '已完成入账' });
}
