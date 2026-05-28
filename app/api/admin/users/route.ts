import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSessionUserFromRequest, isAdminUser } from '@/lib/server-auth';
import { Prisma } from '@prisma/client';

export async function GET(request: Request) {
  const sessionUser = await getSessionUserFromRequest(request);
  if (!isAdminUser(sessionUser)) {
    return NextResponse.json({ success: false, message: '无管理员权限' }, { status: 403 });
  }

  const url = new URL(request.url);
  const keyword = (url.searchParams.get('keyword') || '').trim();
  const taskStatus = (url.searchParams.get('taskStatus') || 'all').trim();
  const page = Math.max(1, Number(url.searchParams.get('page') || '1'));
  const pageSize = Math.min(100, Math.max(10, Number(url.searchParams.get('pageSize') || '20')));

  const where: Prisma.UserWhereInput = {
    ...(keyword
      ? {
          OR: [
            { account: { contains: keyword } },
            { username: { contains: keyword } },
          ],
        }
      : {}),
    ...(taskStatus === 'blocked'
      ? { taskBlocked: true }
      : taskStatus === 'normal'
        ? { taskBlocked: false }
        : {}),
  };

  const [total, users] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        account: true,
        username: true,
        role: true,
        points: true,
        taskBlocked: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
  ]);

  return NextResponse.json({
    success: true,
    data: {
      users,
      total,
      page,
      pageSize,
    },
  });
}
