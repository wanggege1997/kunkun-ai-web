import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSessionUserFromRequest } from '@/lib/server-auth';
import { syncWechatOrderStatus } from '@/lib/payment-service';
import { formatWechatTradeState } from '@/lib/wechat-pay';

export async function GET(
  request: Request,
  context: { params: Promise<{ orderNo: string }> }
) {
  const user = await getSessionUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ success: false, message: '未登录' }, { status: 401 });
  }

  const { orderNo } = await context.params;
  let order = await prisma.paymentOrder.findFirst({
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
      codeUrl: true,
      timeExpireAt: true,
      gatewayStatus: true,
      gatewayCheckedAt: true,
      thirdTradeNo: true,
      paidAmountFen: true,
      paidAt: true,
      refundNo: true,
      refundAmountFen: true,
      refundStatus: true,
      refundedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (!order) {
    return NextResponse.json({ success: false, message: '订单不存在' }, { status: 404 });
  }

  if (order.channel === 'wechat' && order.status === 'pending' && Date.now() - new Date(order.updatedAt).getTime() > 10_000) {
    const synced = await syncWechatOrderStatus(order.orderNo).catch(() => null);
    if (synced?.order) {
      order = {
        ...order,
        ...synced.order,
      };
    }
  }

  return NextResponse.json({
    success: true,
    data: {
      ...order,
      gatewayStatus: order.gatewayStatus || formatWechatTradeState(order.status),
    },
  });
}
