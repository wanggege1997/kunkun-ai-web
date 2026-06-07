import { NextResponse } from 'next/server';
import { changeUserPoints } from '@/lib/points';

function getInternalSecret() {
  return process.env.INTERNAL_WORKER_SECRET || process.env.JWT_SECRET || 'dev-worker-secret';
}

export async function POST(request: Request) {
  try {
    const internalHeader = request.headers.get('x-internal-worker-secret') || '';
    if (!internalHeader || internalHeader !== getInternalSecret()) {
      return NextResponse.json({ success: false, message: '内部鉴权失败' }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const userId = String(body.userId ?? '').trim();
    const points = Number(body.points ?? 0);
    const amount = Number(body.amount ?? 0);
    const operatorId = String(body.operatorId ?? '').trim() || undefined;
    const relatedId = String(body.relatedId ?? '').trim() || undefined;
    if (!Number.isInteger(points) || points <= 0) {
      return NextResponse.json({ success: false, message: 'points 必须是正整数' }, { status: 400 });
    }
    if (!userId) {
      return NextResponse.json({ success: false, message: '缺少用户ID' }, { status: 400 });
    }

    const reason = Number.isFinite(amount) && amount > 0 ? `充值到账 ¥${amount}` : '充值到账';
    const result = await changeUserPoints({
      userId,
      delta: points,
      reason,
      relatedId,
      operatorId,
    });

    return NextResponse.json({
      success: true,
      data: { points: result.points, log: result.log },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : '充值失败';
    return NextResponse.json({ success: false, message }, { status: 500 });
  }
}
