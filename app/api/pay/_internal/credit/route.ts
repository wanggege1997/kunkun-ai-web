import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { changeUserPoints } from '@/lib/points';

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

  const order = await prisma.paymentOrder.findUnique({ where: { orderNo } });
  if (!order) {
    return NextResponse.json({ success: false, message: '订单不存在' }, { status: 404 });
  }

  if (order.amountFen !== paidAmountFen) {
    return NextResponse.json({ success: false, message: '金额校验失败' }, { status: 400 });
  }

  if (order.status === 'credited') {
    return NextResponse.json({
      success: true,
      message: '已处理（幂等）',
      data: { orderNo, status: 'credited', creditedAt: order.updatedAt },
    });
  }

  if (['closed', 'refund_pending', 'refunded'].includes(order.status)) {
    return NextResponse.json({ success: false, message: `订单状态不允许入账: ${order.status}` }, { status: 409 });
  }

  const paidAt = payTimeRaw ? new Date(payTimeRaw) : new Date();
  const safePaidAt = Number.isNaN(paidAt.getTime()) ? new Date() : paidAt;

  const updated = await prisma.paymentOrder.updateMany({
    where: {
      id: order.id,
      status: { in: ['pending', 'paid'] },
    },
    data: {
      status: 'credited',
      thirdTradeNo: thirdTradeNo || order.thirdTradeNo,
      paidAt: order.paidAt || safePaidAt,
    },
  });

  if (updated.count === 0) {
    return NextResponse.json({ success: true, message: '已处理（幂等）', data: { orderNo, status: 'credited' } });
  }

  const existedLog = await prisma.pointLog.findFirst({
    where: {
      userId: order.userId,
      relatedId: order.orderNo,
    },
    select: { id: true },
  });

  if (!existedLog) {
    await changeUserPoints({
      userId: order.userId,
      delta: order.points,
      reason: `${order.channel}充值到账 订单:${order.orderNo}`,
      relatedId: order.orderNo,
    });
  }

  return NextResponse.json({
    success: true,
    data: {
      orderNo,
      status: 'credited',
      points: order.points,
      thirdTradeNo: thirdTradeNo || order.thirdTradeNo,
      creditedAt: new Date().toISOString(),
    },
  });
}
