import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSessionUserFromRequest, isAdminUser } from '@/lib/server-auth';

export async function POST(request: Request) {
  const user = await getSessionUserFromRequest(request);
  if (!isAdminUser(user)) {
    return NextResponse.json({ success: false, message: '无管理员权限' }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const id = String(body?.id || '').trim();
  const maxUses = Math.floor(Number(body?.maxUses || 0));
  if (!id) {
    return NextResponse.json({ success: false, message: '缺少兑换码ID' }, { status: 400 });
  }
  if (!Number.isFinite(maxUses) || maxUses <= 0) {
    return NextResponse.json({ success: false, message: '可使用次数必须大于0' }, { status: 400 });
  }

  const code = await prisma.redeemCode.findUnique({
    where: { id },
    select: { id: true, mode: true, usedCount: true, status: true },
  });
  if (!code) {
    return NextResponse.json({ success: false, message: '兑换码不存在' }, { status: 404 });
  }
  if (code.mode !== 'universal') {
    return NextResponse.json({ success: false, message: '仅通用码支持调整可使用次数' }, { status: 400 });
  }
  if (code.status === 'revoked' || code.status === 'expired') {
    return NextResponse.json({ success: false, message: '当前状态不可调整使用次数' }, { status: 400 });
  }
  if (maxUses < code.usedCount) {
    return NextResponse.json({ success: false, message: `不能小于已使用次数（${code.usedCount}）` }, { status: 400 });
  }

  const nextStatus = code.usedCount >= maxUses ? 'used' : 'active';
  const updated = await prisma.redeemCode.update({
    where: { id },
    data: {
      maxUses,
      status: nextStatus,
      usedAt: nextStatus === 'used' ? undefined : null,
    },
    include: {
      boundUser: { select: { id: true, account: true, username: true } },
      usedByUser: { select: { id: true, account: true, username: true } },
      createdByUser: { select: { id: true, account: true, username: true } },
    },
  });

  return NextResponse.json({ success: true, data: updated });
}
