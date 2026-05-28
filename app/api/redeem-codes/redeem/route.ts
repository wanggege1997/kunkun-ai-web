import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSessionUserFromRequest } from '@/lib/server-auth';
import { getClientIpFromRequest } from '@/lib/security';
import { getRedeemCodeHash, normalizeRedeemCode } from '@/lib/redeem-codes';
import { cacheKeys, invalidateCache } from '@/lib/redis-cache';

export async function POST(request: Request) {
  const user = await getSessionUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ success: false, message: '未登录' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const codeInput = String(body?.code || '').trim();
  if (!codeInput) {
    return NextResponse.json({ success: false, message: '请输入兑换码' }, { status: 400 });
  }

  const normalized = normalizeRedeemCode(codeInput);
  if (normalized.length < 10) {
    return NextResponse.json({ success: false, message: '兑换码格式不正确' }, { status: 400 });
  }

  const codeHash = getRedeemCodeHash(normalized);
  const now = new Date();
  const ip = getClientIpFromRequest(request);
  const ua = request.headers.get('user-agent') || '';

  const code = await prisma.redeemCode.findUnique({
    where: { codeHash },
    select: {
      id: true,
      mode: true,
      status: true,
      points: true,
      boundUserId: true,
      expiresAt: true,
      usedAt: true,
      maxUses: true,
      usedCount: true,
    },
  });

  if (!code) {
    return NextResponse.json({ success: false, message: '兑换码无效' }, { status: 404 });
  }

  if (code.status === 'revoked') {
    return NextResponse.json({ success: false, message: '兑换码已失效' }, { status: 400 });
  }
  if (code.status === 'used') {
    return NextResponse.json({ success: false, message: '兑换码已被使用' }, { status: 400 });
  }
  if (code.expiresAt && code.expiresAt.getTime() <= Date.now()) {
    await prisma.redeemCode.updateMany({
      where: { id: code.id, status: 'active' },
      data: { status: 'expired' },
    }).catch(() => undefined);
    return NextResponse.json({ success: false, message: '兑换码已过期' }, { status: 400 });
  }
  if (code.mode === 'bound' && code.boundUserId !== user.id) {
    return NextResponse.json({ success: false, message: '该兑换码仅限指定用户使用' }, { status: 403 });
  }

  let result: { points: number; delta: number };

  try {
    result = await prisma.$transaction(async (tx) => {
    const latest = await tx.redeemCode.findUnique({
      where: { id: code.id },
      select: {
        id: true,
        mode: true,
        status: true,
        points: true,
        boundUserId: true,
        expiresAt: true,
        maxUses: true,
        usedCount: true,
      },
    });

    if (!latest) {
      throw new Error('兑换码不存在');
    }
    if (latest.status !== 'active') {
      throw new Error('兑换码已失效');
    }
    if (latest.expiresAt && latest.expiresAt.getTime() <= Date.now()) {
      throw new Error('兑换码已过期');
    }
    if (latest.mode === 'bound' && latest.boundUserId !== user.id) {
      throw new Error('该兑换码仅限指定用户使用');
    }
    if (latest.usedCount >= latest.maxUses) {
      throw new Error('兑换码已被使用');
    }

    const usedBefore = await tx.redeemCodeUseLog.findUnique({
      where: {
        redeemCodeId_userId: {
          redeemCodeId: latest.id,
          userId: user.id,
        },
      },
      select: { id: true },
    });
    if (usedBefore) {
      throw new Error('该兑换码你已使用过');
    }

    const nextUsedCount = latest.usedCount + 1;
    const nextStatus = nextUsedCount >= latest.maxUses ? 'used' : 'active';

    const consumed = await tx.redeemCode.updateMany({
      where: {
        id: latest.id,
        status: 'active',
        usedCount: latest.usedCount,
        ...(latest.mode === 'bound' ? { boundUserId: user.id } : {}),
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      data: {
        usedCount: nextUsedCount,
        status: nextStatus,
        usedAt: nextStatus === 'used' ? now : null,
        usedByUserId: nextStatus === 'used' ? user.id : null,
      },
    });

    if (consumed.count === 0) {
      throw new Error('兑换码状态已变化，请刷新后重试');
    }

    const account = await tx.user.findUnique({
      where: { id: user.id },
      select: { points: true },
    });
    if (!account) {
      throw new Error('用户不存在');
    }

    const nextPoints = account.points + code.points;
    const updated = await tx.user.update({
      where: { id: user.id },
      data: { points: nextPoints },
      select: { points: true },
    });

    await tx.pointLog.create({
      data: {
        userId: user.id,
        delta: latest.points,
        reason: '兑换码充值到账',
        relatedId: latest.id,
        balanceAfter: updated.points,
      },
    });

    await tx.redeemCodeUseLog.create({
      data: {
        redeemCodeId: latest.id,
        userId: user.id,
        points: latest.points,
        requestIp: ip,
        userAgent: ua || null,
      },
    });

    return {
      points: updated.points,
      delta: latest.points,
    };
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : '兑换失败，请稍后重试';
    if (message === '该兑换码仅限指定用户使用') {
      return NextResponse.json({ success: false, message }, { status: 403 });
    }
    if (
      message === '兑换码不存在' ||
      message === '兑换码已失效' ||
      message === '兑换码已过期' ||
      message === '兑换码已被使用' ||
      message === '该兑换码你已使用过'
    ) {
      return NextResponse.json({ success: false, message }, { status: 400 });
    }
    if (message === '兑换码状态已变化，请刷新后重试') {
      return NextResponse.json({ success: false, message }, { status: 409 });
    }
    return NextResponse.json({ success: false, message: '兑换失败，请稍后重试' }, { status: 500 });
  }

  await invalidateCache(cacheKeys.user(user.id), cacheKeys.pointLedger(user.id));

  return NextResponse.json({
    success: true,
    data: {
      points: result.points,
      addedPoints: result.delta,
    },
  });
}
