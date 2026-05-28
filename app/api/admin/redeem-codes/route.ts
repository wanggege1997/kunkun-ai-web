import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getSessionUserFromRequest, isAdminUser } from '@/lib/server-auth';

export async function GET(request: Request) {
  const user = await getSessionUserFromRequest(request);
  if (!isAdminUser(user)) {
    return NextResponse.json({ success: false, message: '无管理员权限' }, { status: 403 });
  }

  await prisma.redeemCode.updateMany({
    where: {
      status: 'active',
      expiresAt: { lt: new Date() },
    },
    data: { status: 'expired' },
  }).catch(() => undefined);

  const url = new URL(request.url);
  const status = String(url.searchParams.get('status') || '').trim();
  const mode = String(url.searchParams.get('mode') || '').trim();
  const keyword = String(url.searchParams.get('keyword') || '').trim();
  const page = Math.max(1, Number(url.searchParams.get('page') || '1'));
  const pageSize = Math.min(100, Math.max(10, Number(url.searchParams.get('pageSize') || '30')));

  const where: Prisma.RedeemCodeWhereInput = {
    ...(status ? { status } : {}),
    ...(mode ? { mode } : {}),
    ...(keyword
      ? {
          OR: [
            { codePreview: { contains: keyword } },
            { note: { contains: keyword } },
            { boundUser: { account: { contains: keyword } } },
            { boundUser: { username: { contains: keyword } } },
            { usedByUser: { account: { contains: keyword } } },
            { usedByUser: { username: { contains: keyword } } },
            { createdByUser: { account: { contains: keyword } } },
          ],
        }
      : {}),
  };

  const [total, rows] = await Promise.all([
    prisma.redeemCode.count({ where }),
    prisma.redeemCode.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        boundUser: { select: { id: true, account: true, username: true } },
        usedByUser: { select: { id: true, account: true, username: true } },
        createdByUser: { select: { id: true, account: true, username: true } },
      },
    }),
  ]);

  return NextResponse.json({
    success: true,
    data: {
      rows,
      total,
      page,
      pageSize,
    },
  });
}
