import { NextResponse } from "next/server";
import {
  getSessionTokenFromCookieHeader,
  validateUsername,
  verifySessionToken,
} from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { buildSecurityKey, checkCooldown } from '@/lib/security';
import { SECURITY_POLICY } from '@/lib/security-config';
import { pushSecurityAudit } from '@/lib/risk-control';

export async function PATCH(request: Request) {
  try {
    const token = getSessionTokenFromCookieHeader(request.headers.get("cookie"));
    if (!token) {
      await pushSecurityAudit({
        path: '/api/me/username',
        action: 'change_username',
        result: 'rejected',
        status: 401,
      });
      return NextResponse.json({ success: false }, { status: 401 });
    }

    const payload = await verifySessionToken(token);
    const cooldown = await checkCooldown({
      key: buildSecurityKey('cd:me:username', [payload.userId]),
      cooldownSec: SECURITY_POLICY.cooldown.usernameUpdateSec,
    });
    if (!cooldown.allowed) {
      await pushSecurityAudit({
        userId: payload.userId,
        path: '/api/me/username',
        action: 'change_username',
        result: 'rejected',
        status: 429,
      });
      return NextResponse.json(
        { success: false, message: `操作过于频繁，请${cooldown.retryAfterSec}秒后再试` },
        { status: 429 }
      );
    }

    const body = await request.json();
    const username = String(body.username ?? "").trim();

    if (!validateUsername(username)) {
      await pushSecurityAudit({
        userId: payload.userId,
        path: '/api/me/username',
        action: 'change_username',
        result: 'failed',
        status: 400,
      });
      return NextResponse.json(
        { success: false, message: "用户名需1-12位，中英文/数字/下划线" },
        { status: 400 }
      );
    }

    const existed = await prisma.user.findUnique({ where: { username } });
    if (existed && existed.id !== payload.userId) {
      await pushSecurityAudit({
        userId: payload.userId,
        account: existed.account,
        path: '/api/me/username',
        action: 'change_username',
        result: 'failed',
        status: 409,
      });
      return NextResponse.json(
        { success: false, message: "用户名已被占用" },
        { status: 409 }
      );
    }

    const user = await prisma.user.update({
      where: { id: payload.userId },
      data: { username },
      select: {
        id: true,
        account: true,
        username: true,
        role: true,
        points: true,
        taskBlocked: true,
        avatarType: true,
        avatarValue: true,
      },
    });

    await pushSecurityAudit({
      userId: payload.userId,
      account: user.account,
      path: '/api/me/username',
      action: 'change_username',
      result: 'success',
      status: 200,
    });

    return NextResponse.json({ success: true, data: user });
  } catch {
    await pushSecurityAudit({
      path: '/api/me/username',
      action: 'change_username',
      result: 'failed',
      status: 500,
    }).catch(() => undefined);
    return NextResponse.json(
      { success: false, message: "修改用户名失败" },
      { status: 500 }
    );
  }
}
