import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSessionUserFromRequest } from '@/lib/server-auth';
import { triggerServerQueueWorker } from '@/lib/queue-worker';

type TaskInput = {
  id: string;
  requestId?: string;
  workflowId?: string;
  workflowTitle?: string;
  status?: string;
  taskId?: string | null;
  pointsCost?: number;
  resultUrl?: string | null;
  resultType?: string | null;
  error?: string | null;
  retryPayload?: unknown;
  createdAt?: number;
  updatedAt?: number;
};

function toDate(value: unknown) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return new Date(n);
  return new Date();
}

function isFinishedStatus(status: string) {
  return ['success', 'failed', 'timeout', 'cancelled'].includes(status);
}

function isStartedStatus(status: string) {
  return ['submitting', 'running', 'queueing'].includes(status);
}

export async function GET(request: Request) {
  const user = await getSessionUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ success: false, message: '未登录' }, { status: 401 });
  }

  const url = new URL(request.url);
  const status = String(url.searchParams.get('status') || '').trim();
  const keyword = String(url.searchParams.get('keyword') || '').trim();
  const page = Math.max(1, Number(url.searchParams.get('page') || '1'));
  const pageSize = Math.min(200, Math.max(10, Number(url.searchParams.get('pageSize') || '100')));
  const keepAfter = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);

  await prisma.taskRecord.updateMany({
    where: {
      userId: user.id,
      hiddenAt: null,
      createdAt: { lt: keepAfter },
      status: { in: ['success', 'failed', 'timeout', 'cancelled'] },
    },
    data: {
      hiddenAt: new Date(),
      deliveryStatus: 'delivered',
      deliveryAckAt: new Date(),
      deliveryLastError: null,
      deliveryNextRetryAt: null,
    },
  });

  const where = {
    userId: user.id,
    hiddenAt: null,
    OR: [
      { createdAt: { gte: keepAfter } },
      { status: { in: ['queueing', 'submitting', 'running'] } },
    ],
    ...(status ? { status } : {}),
    ...(keyword
      ? {
          OR: [
            { workflowTitle: { contains: keyword } },
            { workflowId: { contains: keyword } },
            { requestId: { contains: keyword } },
            { taskId: { contains: keyword } },
          ],
        }
      : {}),
  };

  const [total, records] = await Promise.all([
    prisma.taskRecord.count({ where }),
    prisma.taskRecord.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  void triggerServerQueueWorker();

  return NextResponse.json({
    success: true,
    data: {
      total,
      page,
      pageSize,
      records,
    },
  });
}

export async function PUT(request: Request) {
  const user = await getSessionUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ success: false, message: '未登录' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const tasks = Array.isArray(body.tasks) ? (body.tasks as TaskInput[]) : [];

  const valid = tasks.filter((task) => task && typeof task === 'object' && typeof task.id === 'string');
  if (valid.length === 0) {
    return NextResponse.json({ success: true, data: { upserted: 0 } });
  }

  await prisma.$transaction(
    valid.map((task) => {
      const status = String(task.status || 'queueing');
      const requestId = String(task.requestId || task.id || '').trim() || `legacy_${String(task.id || Date.now())}`;
      const payloadJson = task.retryPayload ? JSON.stringify(task.retryPayload) : undefined;
      return prisma.taskRecord.upsert({
        where: { id: task.id },
        create: {
          id: task.id,
          userId: user.id,
          requestId,
          workflowId: String(task.workflowId || ''),
          workflowTitle: String(task.workflowTitle || ''),
          status,
          taskId: task.taskId || null,
          pointsCost: Number(task.pointsCost || 0),
          resultUrl: task.resultUrl || null,
          resultType: task.resultType || null,
          error: task.error || null,
          payloadJson: payloadJson ?? null,
          createdAt: toDate(task.createdAt),
          startedAt: isStartedStatus(status) ? new Date() : null,
          finishedAt: isFinishedStatus(status) ? new Date() : null,
        },
        update: {
          requestId,
          workflowId: String(task.workflowId || ''),
          workflowTitle: String(task.workflowTitle || ''),
          status,
          taskId: task.taskId || null,
          pointsCost: Number(task.pointsCost || 0),
          resultUrl: task.resultUrl || null,
          resultType: task.resultType || null,
          error: task.error || null,
          payloadJson,
          startedAt: isStartedStatus(status) ? new Date() : undefined,
          finishedAt: isFinishedStatus(status) ? new Date() : undefined,
          createdAt: toDate(task.createdAt),
        },
      });
    })
  );

  return NextResponse.json({ success: true, data: { upserted: valid.length } });
}

export async function DELETE(request: Request) {
  const user = await getSessionUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ success: false, message: '未登录' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const ids = Array.isArray(body?.ids)
    ? body.ids
        .map((v: unknown) => String(v || '').trim())
        .filter(Boolean)
    : [];
  const deleteAll = Boolean(body?.deleteAll);

  const terminalStatuses = ['success', 'failed', 'timeout', 'cancelled'];
  const where = {
    userId: user.id,
    hiddenAt: null,
    status: { in: terminalStatuses },
    ...(deleteAll ? {} : { id: { in: ids } }),
  };

  if (!deleteAll && ids.length === 0) {
    return NextResponse.json({ success: false, message: '缺少删除任务ID' }, { status: 400 });
  }

  const result = await prisma.taskRecord.updateMany({
    where,
    data: {
      hiddenAt: new Date(),
      deliveryStatus: 'delivered',
      deliveryAckAt: new Date(),
      deliveryLastError: null,
      deliveryNextRetryAt: null,
    },
  });

  return NextResponse.json({ success: true, data: { hidden: result.count } });
}
