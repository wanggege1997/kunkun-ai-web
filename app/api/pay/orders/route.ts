import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSessionUserFromRequest } from '@/lib/server-auth';
import { createOrderNo } from '@/lib/payment';
import { createWechatNativePaymentOrder } from '@/lib/payment-service';

const ORDER_REUSE_WINDOW_MS = 5 * 60 * 1000;
const ORDER_CREATE_LIMIT_WINDOW_MS = 60 * 1000;
const ORDER_CREATE_LIMIT_COUNT = 3;

async function pruneOverflowPendingOrders(userId: string, keep = 5) {
  const pendingOrders = await prisma.paymentOrder.findMany({
    where: {
      userId,
      status: 'pending',
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });

  if (pendingOrders.length <= keep) return;

  const overflowIds = pendingOrders.slice(keep).map((item) => item.id);
  if (overflowIds.length === 0) return;

  await prisma.paymentOrder.updateMany({
    where: {
      id: { in: overflowIds },
      status: 'pending',
    },
    data: {
      status: 'closed',
      clientOrderNo: 'closed:auto_prune_overflow_pending',
    },
  });
}

export async function POST(request: Request) {
  const user = await getSessionUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ success: false, message: '未登录' }, { status: 401 });
  }

  const rateWindowStart = new Date(Date.now() - ORDER_CREATE_LIMIT_WINDOW_MS);
  const recentCreateCount = await prisma.paymentOrder.count({
    where: {
      userId: user.id,
      createdAt: { gte: rateWindowStart },
    },
  });
  if (recentCreateCount >= ORDER_CREATE_LIMIT_COUNT) {
    return NextResponse.json(
      { success: false, message: '操作过于频繁，请一分钟后再试' },
      { status: 429 }
    );
  }

  const body = await request.json().catch(() => ({}));
  const channel = String(body.channel || '').trim();
  const amountFen = Number(body.amountFen || 0);
  const points = Number(body.points || 0);
  const clientOrderNo = String(body.clientOrderNo || '').trim() || null;

  if (!['wechat', 'alipay'].includes(channel)) {
    return NextResponse.json({ success: false, message: '不支持的支付渠道' }, { status: 400 });
  }
  if (!Number.isInteger(amountFen) || amountFen <= 0) {
    return NextResponse.json({ success: false, message: '金额不合法' }, { status: 400 });
  }
  if (!Number.isInteger(points) || points <= 0) {
    return NextResponse.json({ success: false, message: '积分数量不合法' }, { status: 400 });
  }

  const reuseAfter = new Date(Date.now() - ORDER_REUSE_WINDOW_MS);
  const reusableOrder = await prisma.paymentOrder.findFirst({
    where: {
      userId: user.id,
      channel,
      amountFen,
      points,
      status: 'pending',
      createdAt: { gte: reuseAfter },
    },
    orderBy: { createdAt: 'desc' },
    select: {
      orderNo: true,
      channel: true,
      amountFen: true,
      points: true,
      status: true,
      codeUrl: true,
      timeExpireAt: true,
      createdAt: true,
    },
  });

  if (reusableOrder && (channel !== 'wechat' || (reusableOrder.codeUrl && reusableOrder.timeExpireAt && reusableOrder.timeExpireAt.getTime() > Date.now()))) {
    await pruneOverflowPendingOrders(user.id, 5);
    return NextResponse.json({
      success: true,
      data: {
        ...reusableOrder,
        reused: true,
        payUrl: `/pay/${reusableOrder.orderNo}`,
      },
    });
  }

  const orderNo = createOrderNo('PO');
  const timeExpireAt = new Date(Date.now() + 15 * 60 * 1000);
  const order = await prisma.paymentOrder.create({
    data: {
      orderNo,
      userId: user.id,
      channel,
      amountFen,
      points,
      clientOrderNo,
      timeExpireAt,
      status: 'pending',
    },
    select: {
      orderNo: true,
      channel: true,
      amountFen: true,
      points: true,
      status: true,
      codeUrl: true,
      timeExpireAt: true,
      createdAt: true,
    },
  });

  let codeUrl: string | null = null;
  if (channel === 'wechat') {
    try {
      codeUrl = await createWechatNativePaymentOrder({
        orderNo,
        amountFen,
        description: `坤坤 AI 积分充值 ${points}积分`,
        timeExpireAt,
      });
    } catch (error: unknown) {
      await prisma.paymentOrder.updateMany({
        where: { orderNo, status: 'pending' },
        data: {
          status: 'failed',
          clientOrderNo: clientOrderNo || 'wechat_native_create_failed',
        },
      });
      const message = error instanceof Error ? error.message : '微信支付下单失败';
      return NextResponse.json({ success: false, message }, { status: 502 });
    }
  }

  await pruneOverflowPendingOrders(user.id, 5);

  return NextResponse.json({
    success: true,
    data: {
      ...order,
      codeUrl: codeUrl || order.codeUrl,
      timeExpireAt,
      reused: false,
      payUrl: `/pay/${order.orderNo}`,
    },
  });
}
