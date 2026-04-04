import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSessionUserFromRequest } from '@/lib/server-auth';

export async function POST(
  request: Request,
  context: { params: Promise<{ orderNo: string }> }
) {
  const user = await getSessionUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ success: false, message: '未登录' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const reason = String(body?.reason || '').trim() || 'user_cancel';
  const { orderNo } = await context.params;

  const order = await prisma.paymentOrder.findFirst({
    where: {
      orderNo,
      userId: user.id,
    },
  });
  if (!order) {
    return NextResponse.json({ success: false, message: '订单不存在' }, { status: 404 });
  }

  if (order.status === 'closed') {
    return NextResponse.json({ success: true, message: '已关闭（幂等）', data: { orderNo, status: 'closed' } });
  }

  if (['paid', 'credited', 'refund_pending', 'refunded'].includes(order.status)) {
    return NextResponse.json({ success: false, message: `订单状态不允许关闭: ${order.status}` }, { status: 409 });
  }

  const updated = await prisma.paymentOrder.updateMany({
    where: {
      id: order.id,
      status: 'pending',
    },
    data: {
      status: 'closed',
      clientOrderNo: order.clientOrderNo || `closed:${reason}`,
    },
  });

  if (updated.count === 0) {
    return NextResponse.json({ success: true, message: '已处理（幂等）', data: { orderNo, status: 'closed' } });
  }

  return NextResponse.json({
    success: true,
    data: {
      orderNo,
      status: 'closed',
      reason,
    },
  });
}
