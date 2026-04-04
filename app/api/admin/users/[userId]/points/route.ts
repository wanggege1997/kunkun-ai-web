import { NextResponse } from 'next/server';
import { changeUserPoints } from '@/lib/points';
import { getSessionUserFromRequest, isAdminUser } from '@/lib/server-auth';

export async function POST(
  request: Request,
  context: { params: Promise<{ userId: string }> }
) {
  const sessionUser = await getSessionUserFromRequest(request);
  if (!isAdminUser(sessionUser)) {
    return NextResponse.json({ success: false, message: '无管理员权限' }, { status: 403 });
  }
  const adminUserId = sessionUser.id;

  const { userId } = await context.params;
  const body = await request.json().catch(() => ({}));
  const delta = Number(body.delta ?? 0);
  const reason = String(body.reason ?? '').trim() || '管理员手动调账';

  if (!Number.isInteger(delta) || delta === 0) {
    return NextResponse.json({ success: false, message: 'delta 必须是非零整数' }, { status: 400 });
  }

  try {
    const result = await changeUserPoints({
      userId,
      delta,
      reason,
      operatorId: adminUserId,
      allowNegative: false,
    });

    return NextResponse.json({ success: true, data: { points: result.points, log: result.log } });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : '积分调整失败';
    const status = message === '积分不足' ? 409 : 500;
    return NextResponse.json({ success: false, message }, { status });
  }
}
