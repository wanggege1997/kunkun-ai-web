import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSessionUserFromRequest } from '@/lib/server-auth';
import { getQueueRuntimeConfig } from '@/lib/queue-config';
import { triggerServerQueueWorker } from '@/lib/queue-worker';

export async function POST(request: Request) {
  const user = await getSessionUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ success: false, message: '未登录' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const taskRecordId = String(body?.taskRecordId || '').trim();
  const action = String(body?.action || '').trim();
  const reason = String(body?.reason || '').trim();

  if (!taskRecordId) {
    return NextResponse.json({ success: false, message: '缺少任务ID' }, { status: 400 });
  }
  if (!['ack', 'fail'].includes(action)) {
    return NextResponse.json({ success: false, message: '无效的投递动作' }, { status: 400 });
  }

  const record = await prisma.taskRecord.findFirst({
    where: { id: taskRecordId, userId: user.id },
  });
  if (!record) {
    return NextResponse.json({ success: false, message: '任务不存在' }, { status: 404 });
  }
  if (record.status !== 'success') {
    return NextResponse.json({ success: false, message: '当前任务尚未成功，无法更新投递状态' }, { status: 409 });
  }

  if (action === 'ack') {
    const updated = await prisma.taskRecord.update({
      where: { id: taskRecordId },
      data: {
        deliveryStatus: 'delivered',
        deliveryAckAt: new Date(),
        deliveryLastError: null,
        deliveryNextRetryAt: null,
      },
    });

    return NextResponse.json({ success: true, data: updated });
  }

  const cfg = await getQueueRuntimeConfig();
  const nextAttempt = Number(record.deliveryAttempts || 0) + 1;
  const maxAttempts = Math.max(1, Number(record.deliveryMaxAttempts || cfg.delivery.maxAttempts));
  const errorMessage = reason || '前端展示失败，已加入结果重投递队列';

  const updated = await prisma.taskRecord.update({
    where: { id: taskRecordId },
    data: {
      deliveryStatus: nextAttempt >= maxAttempts ? 'failed' : 'retrying',
      deliveryAttempts: nextAttempt,
      deliveryLastError: errorMessage,
      deliveryNextRetryAt: nextAttempt >= maxAttempts ? null : new Date(Date.now() + cfg.delivery.retryIntervalMs),
    },
  });

  void triggerServerQueueWorker();

  return NextResponse.json({ success: true, data: updated });
}
