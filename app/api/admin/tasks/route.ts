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
  const status = String(url.searchParams.get('status') || '').trim();
  const account = String(url.searchParams.get('account') || '').trim();
  const keyword = String(url.searchParams.get('keyword') || '').trim();
  const includeHidden = url.searchParams.get('includeHidden') === '1';
  const anomalyOnly = url.searchParams.get('anomalyOnly') === '1';
  const anomalyType = String(url.searchParams.get('anomalyType') || '').trim();
  const fromTs = Number(url.searchParams.get('from') || '0');
  const toTs = Number(url.searchParams.get('to') || '0');
  const page = Math.max(1, Number(url.searchParams.get('page') || '1'));
  const pageSize = Math.min(200, Math.max(10, Number(url.searchParams.get('pageSize') || '50')));

  const where: Prisma.TaskRecordWhereInput = {
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

  if (anomalyOnly) {
    const anomalyCondition: Prisma.TaskRecordWhereInput =
      anomalyType === 'failed'
        ? { status: 'failed' }
        : anomalyType === 'timeout'
          ? { status: 'timeout' }
          : anomalyType === 'delivery'
            ? {
                OR: [
                  { deliveryStatus: 'failed' },
                  { deliveryLastError: { not: null } },
                ],
              }
            : anomalyType === 'alert'
              ? { error: { startsWith: '告警：' } }
              : anomalyType === 'execution'
                ? {
                    AND: [
                      { error: { not: null } },
                      { error: { not: { startsWith: '告警：' } } },
                      { status: { notIn: ['failed', 'timeout'] } },
                    ],
                  }
                : {
                    OR: [
                      { status: { in: ['failed', 'timeout'] } },
                      { deliveryStatus: 'failed' },
                      { error: { not: null } },
                      { deliveryLastError: { not: null } },
                    ],
                  };

    where.AND = [anomalyCondition];
  }

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
