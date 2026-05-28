import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSessionUserFromRequest, isAdminUser } from '@/lib/server-auth';

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const user = await getSessionUserFromRequest(request);
  if (!isAdminUser(user)) {
    return NextResponse.json({ success: false, message: '无管理员权限' }, { status: 403 });
  }

  const { id } = await context.params;

  const record = await prisma.redeemCode.findUnique({
    where: { id },
    include: {
      boundUser: { select: { id: true, account: true, username: true } },
      usedByUser: { select: { id: true, account: true, username: true } },
      createdByUser: { select: { id: true, account: true, username: true } },
      useLogs: {
        orderBy: { createdAt: 'desc' },
        take: 20,
        include: {
          user: { select: { id: true, account: true, username: true } },
        },
      },
    },
  });

  if (!record) {
    return NextResponse.json({ success: false, message: '兑换码不存在' }, { status: 404 });
  }

  return NextResponse.json({ success: true, data: record });
}
