import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSessionUserFromRequest } from '@/lib/server-auth';
import { triggerServerQueueWorker } from '@/lib/queue-worker';
import { getGlobalStopEnabled } from '@/lib/points';
import { Prisma } from '@prisma/client';

type EnqueueTask = {
  id?: string;
  requestId?: string;
  workflowId?: string;
  workflowTitle?: string;
  pointsCost?: number;
  payload?: unknown;
  createdAt?: number;
};

export async function POST(request: Request) {
  const user = await getSessionUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ success: false, message: '未登录' }, { status: 401 });
  }

  if (user.taskBlocked) {
    return NextResponse.json({ success: false, message: '当前账号任务已暂停，请联系管理员处理' }, { status: 403 });
  }

  const globalStopped = await getGlobalStopEnabled();
  if (globalStopped) {
    return NextResponse.json({ success: false, message: '系统已开启全局紧急停机，请稍后重试' }, { status: 503 });
  }

  const body = await request.json().catch(() => ({}));
  const tasks = Array.isArray(body.tasks) ? (body.tasks as EnqueueTask[]) : [];
  if (tasks.length === 0) {
    return NextResponse.json({ success: false, message: '缺少任务数据' }, { status: 400 });
  }

  const valid = tasks.filter((task) => task.workflowId && String(task.requestId || '').trim() && task.payload);
  if (valid.length === 0) {
    return NextResponse.json({ success: false, message: '任务参数不完整' }, { status: 400 });
  }

  let created = 0;
  let duplicated = 0;

  for (const task of valid) {
    const requestId = String(task.requestId || '').trim();
    const workflowId = String(task.workflowId || '').trim();
    const existing = await prisma.taskRecord.findUnique({
      where: {
        userId_requestId: {
          userId: user.id,
          requestId,
        },
      },
      select: { id: true },
    });

    if (existing) {
      duplicated += 1;
      continue;
    }

    try {
      await prisma.taskRecord.create({
        data: {
          id: String(task.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
          userId: user.id,
          requestId,
          workflowId,
          workflowTitle: String(task.workflowTitle || ''),
          status: 'queueing',
          pointsCost: Number(task.pointsCost || 0),
          payloadJson: JSON.stringify(task.payload),
          createdAt: new Date(Number(task.createdAt || Date.now())),
        },
      });
      created += 1;
    } catch (error: unknown) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        duplicated += 1;
        continue;
      }
      throw error;
    }
  }

  if (created > 0) {
    void triggerServerQueueWorker();
  }

  return NextResponse.json({
    success: true,
    data: {
      queued: created,
      duplicated,
    },
  });
}
