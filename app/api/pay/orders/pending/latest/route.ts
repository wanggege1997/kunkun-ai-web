import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSessionUserFromRequest } from '@/lib/server-auth';

const ORDER_EXPIRE_MS = 15 * 60 * 1000;

export async function GET(request: Request) {
  const user = await getSessionUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ success: false, message: '未登录' }, { status: 401 });
  }

  const now = Date.now();
  const cutoff = new Date(now - ORDER_EXPIRE_MS);

  const list = await prisma.paymentOrder.findMany({
    where: {
      userId: user.id,
      status: 'pending',
      createdAt: { gte: cutoff },
    },
    orderBy: { createdAt: 'desc' },
    take: 5,
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

  if (!list.length) {
    return NextResponse.json({ success: true, data: [] });
  }

  const data = list.map((row) => {
    const expireAt = row.timeExpireAt || new Date(new Date(row.createdAt).getTime() + ORDER_EXPIRE_MS);
    const remainingSeconds = Math.max(0, Math.floor((expireAt.getTime() - now) / 1000));
    return {
      ...row,
      expireAt: expireAt.toISOString(),
      remainingSeconds,
    };
  });

  return NextResponse.json({
    success: true,
    data,
  });
}
