import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSessionUserFromRequest } from '@/lib/server-auth';
import { createOrderNo } from '@/lib/payment';

export async function POST(request: Request) {
  const user = await getSessionUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ success: false, message: '未登录' }, { status: 401 });
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

  const orderNo = createOrderNo('PO');
  const order = await prisma.paymentOrder.create({
    data: {
      orderNo,
      userId: user.id,
      channel,
      amountFen,
      points,
      clientOrderNo,
      status: 'pending',
    },
    select: {
      orderNo: true,
      channel: true,
      amountFen: true,
      points: true,
      status: true,
      createdAt: true,
    },
  });

  return NextResponse.json({
    success: true,
    data: {
      ...order,
      payUrl: `/pay/mock/${order.orderNo}`,
    },
  });
}
