import { NextResponse } from 'next/server';
import { getSessionUserFromRequest } from '@/lib/server-auth';
import { cancelQueuedTaskById } from '@/lib/queue-worker';

export async function POST(request: Request) {
  const user = await getSessionUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ success: false, message: '未登录' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const id = String(body.id || '').trim();
  if (!id) {
    return NextResponse.json({ success: false, message: '缺少任务ID' }, { status: 400 });
  }

  try {
    const record = await cancelQueuedTaskById(user.id, id);
    return NextResponse.json({ success: true, data: { id: record.id, pointsCost: record.pointsCost } });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : '取消失败';
    return NextResponse.json({ success: false, message }, { status: 400 });
  }
}
