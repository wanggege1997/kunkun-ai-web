import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSessionUserFromRequest, isAdminUser } from '@/lib/server-auth';

export async function POST(request: Request) {
  const user = await getSessionUserFromRequest(request);
  if (!isAdminUser(user)) {
    return NextResponse.json({ success: false, message: '无管理员权限' }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const id = String(body?.id || '').trim();
  if (!id) {
    return NextResponse.json({ success: false, message: '缺少兑换码ID' }, { status: 400 });
  }

  const updated = await prisma.redeemCode.updateMany({
    where: { id, status: 'active', usedAt: null },
    data: { status: 'revoked' },
  });

  if (updated.count === 0) {
    return NextResponse.json({ success: false, message: '仅未使用的有效兑换码可撤销' }, { status: 400 });
  }

  const record = await prisma.redeemCode.findUnique({
    where: { id },
    include: {
      boundUser: { select: { id: true, account: true, username: true } },
      usedByUser: { select: { id: true, account: true, username: true } },
      createdByUser: { select: { id: true, account: true, username: true } },
    },
  });

  return NextResponse.json({ success: true, data: record });
}
