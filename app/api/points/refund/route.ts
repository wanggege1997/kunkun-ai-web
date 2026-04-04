import { NextResponse } from 'next/server';
import { changeUserPoints } from '@/lib/points';
import { getSessionUserFromRequest } from '@/lib/server-auth';

export async function POST(request: Request) {
  try {
    const user = await getSessionUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ success: false, message: '未登录' }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const points = Number(body.points ?? 0);
    const reason = String(body.reason ?? '').trim() || '任务退款';
    const relatedId = String(body.relatedId ?? '').trim() || undefined;

    if (!Number.isInteger(points) || points <= 0) {
      return NextResponse.json({ success: false, message: 'points 必须是正整数' }, { status: 400 });
    }

    const result = await changeUserPoints({
      userId: user.id,
      delta: points,
      reason,
      relatedId,
    });

    return NextResponse.json({
      success: true,
      data: { points: result.points, log: result.log },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : '退款失败';
    return NextResponse.json({ success: false, message }, { status: 500 });
  }
}
