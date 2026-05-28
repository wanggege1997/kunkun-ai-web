import bcrypt from 'bcryptjs';
import { NextResponse } from 'next/server';
import {
  getSessionTokenFromCookieHeader,
  validatePassword,
  verifySessionToken,
} from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { buildSecurityKey, checkCooldown } from '@/lib/security';
import { SECURITY_POLICY } from '@/lib/security-config';
import { pushSecurityAudit } from '@/lib/risk-control';

export async function PATCH(request: Request) {
  try {
    const token = getSessionTokenFromCookieHeader(request.headers.get('cookie'));
    if (!token) {
      await pushSecurityAudit({
        path: '/api/me/password',
        action: 'change_password',
        result: 'rejected',
        status: 401,
      });
      return NextResponse.json({ success: false }, { status: 401 });
    }

    const payload = await verifySessionToken(token);
    const cooldown = await checkCooldown({
      key: buildSecurityKey('cd:me:password', [payload.userId]),
      cooldownSec: SECURITY_POLICY.cooldown.passwordUpdateSec,
    });
    if (!cooldown.allowed) {
      await pushSecurityAudit({
        userId: payload.userId,
        path: '/api/me/password',
        action: 'change_password',
        result: 'rejected',
        status: 429,
      });
      return NextResponse.json(
        { success: false, message: `操作过于频繁，请${cooldown.retryAfterSec}秒后再试` },
        { status: 429 }
      );
    }

    const body = await request.json();
    const currentPassword = String(body.currentPassword ?? '');
    const newPassword = String(body.newPassword ?? '');

    if (!currentPassword) {
      await pushSecurityAudit({
        userId: payload.userId,
        path: '/api/me/password',
        action: 'change_password',
        result: 'failed',
        status: 400,
      });
      return NextResponse.json(
        { success: false, message: '请输入当前密码' },
        { status: 400 }
      );
    }

    if (!validatePassword(newPassword)) {
      await pushSecurityAudit({
        userId: payload.userId,
        path: '/api/me/password',
        action: 'change_password',
        result: 'failed',
        status: 400,
      });
      return NextResponse.json(
        { success: false, message: '新密码必须8-20位，且包含字母和数字' },
        { status: 400 }
      );
    }

    const user = await prisma.user.findUnique({ where: { id: payload.userId } });
    if (!user) {
      await pushSecurityAudit({
        userId: payload.userId,
        path: '/api/me/password',
        action: 'change_password',
        result: 'rejected',
        status: 401,
      });
      return NextResponse.json({ success: false }, { status: 401 });
    }

    const ok = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!ok) {
      await pushSecurityAudit({
        userId: payload.userId,
        account: user.account,
        path: '/api/me/password',
        action: 'change_password',
        result: 'failed',
        status: 401,
      });
      return NextResponse.json(
        { success: false, message: '当前密码错误' },
        { status: 401 }
      );
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({
      where: { id: payload.userId },
      data: { passwordHash },
    });

    await pushSecurityAudit({
      userId: payload.userId,
      account: user.account,
      path: '/api/me/password',
      action: 'change_password',
      result: 'success',
      status: 200,
    });

    return NextResponse.json({ success: true });
  } catch {
    await pushSecurityAudit({
      path: '/api/me/password',
      action: 'change_password',
      result: 'failed',
      status: 500,
    }).catch(() => undefined);
    return NextResponse.json(
      { success: false, message: '修改密码失败' },
      { status: 500 }
    );
  }
}
