import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getSessionUserFromRequest, isAdminUser } from '@/lib/server-auth';
import { buildRedeemCodePreview, generateRedeemCode, getRedeemCodeHash, type RedeemCodeMode } from '@/lib/redeem-codes';

function normalizeMode(value: unknown): RedeemCodeMode {
  return value === 'bound' ? 'bound' : 'universal';
}

export async function POST(request: Request) {
  const user = await getSessionUserFromRequest(request);
  if (!isAdminUser(user)) {
    return NextResponse.json({ success: false, message: '无管理员权限' }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const mode = normalizeMode(body?.mode);
  const points = Math.floor(Number(body?.points || 0));
  const maxUsesInput = Math.floor(Number(body?.maxUses || 1));
  const expiresInDaysInput = Math.floor(Number(body?.expiresInDays || 0));
  const boundUserId = String(body?.boundUserId || '').trim();
  const note = String(body?.note || '').trim();

  if (!Number.isFinite(points) || points <= 0) {
    return NextResponse.json({ success: false, message: '积分必须是大于0的整数' }, { status: 400 });
  }

  if (!Number.isFinite(maxUsesInput) || maxUsesInput <= 0) {
    return NextResponse.json({ success: false, message: '可使用次数必须大于0' }, { status: 400 });
  }

  if (!Number.isFinite(expiresInDaysInput) || expiresInDaysInput < 0) {
    return NextResponse.json({ success: false, message: '有效期天数格式不正确' }, { status: 400 });
  }

  if (mode === 'bound' && !boundUserId) {
    return NextResponse.json({ success: false, message: '专属码必须绑定用户' }, { status: 400 });
  }

  let targetUser: { id: string; account: string; username: string } | null = null;
  if (mode === 'bound') {
    targetUser = await prisma.user.findUnique({
      where: { id: boundUserId },
      select: { id: true, account: true, username: true },
    });
    if (!targetUser) {
      return NextResponse.json({ success: false, message: '绑定用户不存在' }, { status: 404 });
    }
  }

  const maxUses = mode === 'bound' ? 1 : maxUsesInput;
  const expiresAt = expiresInDaysInput > 0
    ? new Date(Date.now() + expiresInDaysInput * 24 * 60 * 60 * 1000)
    : null;

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const plainCode = generateRedeemCode();
    const codeHash = getRedeemCodeHash(plainCode);

    try {
      const created = await prisma.redeemCode.create({
        data: {
          codeHash,
          codePreview: buildRedeemCodePreview(plainCode),
          mode,
          boundUserId: mode === 'bound' ? boundUserId : null,
          points,
          amountFen: null,
          exchangeRate: 100,
          maxUses,
          usedCount: 0,
          status: 'active',
          expiresAt,
          note: note || null,
          createdByUserId: user.id,
        },
        include: {
          boundUser: { select: { id: true, account: true, username: true } },
          createdByUser: { select: { id: true, account: true, username: true } },
        },
      });

      return NextResponse.json({
        success: true,
        data: {
          plainCode,
          record: created,
          boundUser: targetUser,
        },
      });
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        continue;
      }
      throw error;
    }
  }

  return NextResponse.json({ success: false, message: '兑换码生成冲突，请重试' }, { status: 500 });
}
