import { NextResponse } from 'next/server';
import { creditPaymentOrder } from '@/lib/payment-service';

function getInternalSecret() {
  return process.env.INTERNAL_WORKER_SECRET || process.env.JWT_SECRET || 'dev-worker-secret';
}

export async function POST(request: Request) {
  const internalHeader = request.headers.get('x-internal-worker-secret') || '';
  if (!internalHeader || internalHeader !== getInternalSecret()) {
    return NextResponse.json({ success: false, message: '内部鉴权失败' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const orderNo = String(body?.orderNo || '').trim();
  const thirdTradeNo = String(body?.thirdTradeNo || '').trim() || null;
  const paidAmountFen = Number(body?.paidAmountFen || 0);
  const payTimeRaw = String(body?.payTime || '').trim();

  if (!orderNo) {
    return NextResponse.json({ success: false, message: '缺少订单号' }, { status: 400 });
  }
  if (!Number.isInteger(paidAmountFen) || paidAmountFen <= 0) {
    return NextResponse.json({ success: false, message: '支付金额不合法' }, { status: 400 });
  }

  try {
    const result = await creditPaymentOrder({
      orderNo,
      thirdTradeNo,
      paidAmountFen,
      paidAt: payTimeRaw ? new Date(payTimeRaw) : new Date(),
      rawNotify: body?.rawNotify || body,
    });

    return NextResponse.json({
      success: true,
      message: result.credited ? '已入账' : '已处理（幂等）',
      data: {
        orderNo,
        status: 'credited',
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : '入账失败';
    const status = message.includes('不允许入账') ? 409 : 400;
    return NextResponse.json({ success: false, message }, { status });
  }
}
