import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSessionUserFromRequest, isAdminUser } from '@/lib/server-auth';

export async function GET(request: Request) {
  const sessionUser = await getSessionUserFromRequest(request);
  if (!isAdminUser(sessionUser)) {
    return NextResponse.json({ success: false, message: '无管理员权限' }, { status: 403 });
  }

  const url = new URL(request.url);
  const status = String(url.searchParams.get('status') || '').trim();
  const account = String(url.searchParams.get('account') || '').trim();
  const keyword = String(url.searchParams.get('keyword') || '').trim();
  const includeHidden = url.searchParams.get('includeHidden') === '1';
  const fromTs = Number(url.searchParams.get('from') || '0');
  const toTs = Number(url.searchParams.get('to') || '0');
  const page = Math.max(1, Number(url.searchParams.get('page') || '1'));
  const pageSize = Math.min(200, Math.max(10, Number(url.searchParams.get('pageSize') || '50')));

  const where = {
    ...(includeHidden ? {} : { hiddenAt: null }),
    ...(status ? { status } : {}),
    ...(fromTs || toTs
      ? {
          createdAt: {
            ...(fromTs ? { gte: new Date(fromTs) } : {}),
            ...(toTs ? { lte: new Date(toTs) } : {}),
          },
        }
      : {}),
    ...(keyword
      ? {
          OR: [
            { workflowTitle: { contains: keyword } },
            { workflowId: { contains: keyword } },
            { requestId: { contains: keyword } },
            { taskId: { contains: keyword } },
            { error: { contains: keyword } },
            { deliveryLastError: { contains: keyword } },
          ],
        }
      : {}),
    ...(account
      ? {
          user: {
            account: { contains: account },
          },
        }
      : {}),
  };

  const [total, rows] = await Promise.all([
    prisma.taskRecord.count({ where }),
    prisma.taskRecord.findMany({
      where,
      include: {
        user: {
          select: {
            id: true,
            account: true,
            username: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  return NextResponse.json({
    success: true,
    data: {
      total,
      page,
      pageSize,
      rows,
    },
  });
}
