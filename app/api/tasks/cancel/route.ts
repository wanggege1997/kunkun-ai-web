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
    const result = await cancelQueuedTaskById(user.id, id);
    return NextResponse.json({
      success: true,
      data: {
        id: result.record.id,
        pointsCost: result.record.pointsCost,
        refunded: result.refunded,
        pointsDelta: result.pointsDelta,
        chargedPoints: result.chargedPoints,
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : '取消失败';
    const status = message.includes('已完成生成') ? 409 : 400;
    return NextResponse.json({ success: false, message }, { status });
  }
}
