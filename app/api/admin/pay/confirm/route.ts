import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { changeUserPoints } from '@/lib/points';
import { getSessionUserFromRequest, isAdminUser } from '@/lib/server-auth';

/**
 * POST /api/admin/pay/confirm
 * 管理员手动确认订单支付成功（用于微信/支付宝支付接入前的过渡方案）
 *
 * Body: { orderNo: string, note?: string }
 */
export async function POST(request: Request) {
  const sessionUser = await getSessionUserFromRequest(request);
  if (!isAdminUser(sessionUser)) {
    return NextResponse.json({ success: false, message: '无管理员权限' }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const orderNo = String(body.orderNo || '').trim();
  const note = String(body.note || '').trim() || '管理员手动确认支付';

  if (!orderNo) {
    return NextResponse.json({ success: false, message: '缺少订单号' }, { status: 400 });
  }

  const order = await prisma.paymentOrder.findUnique({ where: { orderNo } });
  if (!order) {
    return NextResponse.json({ success: false, message: '订单不存在' }, { status: 404 });
  }

  // 幂等：已入账直接返回成功
  if (order.status === 'credited') {
    return NextResponse.json({
      success: true,
      message: '订单已入账（幂等）',
      data: { orderNo, status: 'credited', points: order.points },
    });
  }

  // 只允许对 pending/paid 状态的订单操作
  if (!['pending', 'paid'].includes(order.status)) {
    return NextResponse.json(
      { success: false, message: `订单状态为 ${order.status}，无法确认支付` },
      { status: 409 }
    );
  }

  // 原子更新订单状态
  const updated = await prisma.paymentOrder.updateMany({
    where: { id: order.id, status: { in: ['pending', 'paid'] } },
    data: {
      status: 'credited',
      paidAt: new Date(),
      thirdTradeNo: `MANUAL-${sessionUser.id}-${Date.now()}`,
    },
  });

  if (updated.count === 0) {
    return NextResponse.json({ success: true, message: '已处理（幂等）', data: { orderNo } });
  }

  // 检查是否已有积分记录（防重复入账）
  const existingLog = await prisma.pointLog.findFirst({
    where: { userId: order.userId, relatedId: order.orderNo },
    select: { id: true },
  });

  if (!existingLog) {
    await changeUserPoints({
      userId: order.userId,
      delta: order.points,
      reason: `${note} 订单:${order.orderNo}`,
      relatedId: order.orderNo,
      operatorId: sessionUser.id,
    });
  }

  return NextResponse.json({
    success: true,
    message: '支付确认成功，积分已到账',
    data: {
      orderNo,
      status: 'credited',
      points: order.points,
      userId: order.userId,
      confirmedBy: sessionUser.id,
      confirmedAt: new Date().toISOString(),
    },
  });
}
