import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";
import {
  setSessionCookie,
  signSessionToken,
  validateAccount,
  validatePassword,
} from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { buildSecurityKey, consumeRateLimit, getClientIpFromRequest } from '@/lib/security';
import { SECURITY_POLICY } from '@/lib/security-config';
import {
  pushSecurityAudit,
  registerLoginFailure,
  reportLoginRateLimited,
  resetLoginFailure,
} from '@/lib/risk-control';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const account = String(body.account ?? "").trim();
    const password = String(body.password ?? "");
    const ip = getClientIpFromRequest(request);

    const limitResult = await consumeRateLimit({
      key: buildSecurityKey('rl:auth:login', [ip, account || 'empty']),
      limit: SECURITY_POLICY.auth.login.limit,
      windowSec: SECURITY_POLICY.auth.login.windowSec,
    });
    if (!limitResult.allowed) {
      await reportLoginRateLimited({ ip, account, retryAfterSec: limitResult.retryAfterSec });
      await pushSecurityAudit({
        account,
        ip,
        path: '/api/auth/login-password',
        action: 'password_login',
        result: 'rejected',
        status: 429,
      });
      return NextResponse.json(
        { success: false, message: `操作过于频繁，请${limitResult.retryAfterSec}秒后再试` },
        { status: 429 }
      );
    }

    if (!validateAccount(account) || !validatePassword(password)) {
      await registerLoginFailure({ ip, account, route: '/api/auth/login-password' });
      await pushSecurityAudit({
        account,
        ip,
        path: '/api/auth/login-password',
        action: 'password_login',
        result: 'failed',
        status: 400,
      });
      return NextResponse.json(
        { success: false, message: "账号或密码错误" },
        { status: 400 }
      );
    }

    const user = await prisma.user.findUnique({ where: { account } });
    if (!user) {
      await registerLoginFailure({ ip, account, route: '/api/auth/login-password' });
      await pushSecurityAudit({
        account,
        ip,
        path: '/api/auth/login-password',
        action: 'password_login',
        result: 'failed',
        status: 401,
      });
      return NextResponse.json(
        { success: false, message: "账号或密码错误" },
        { status: 401 }
      );
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      await registerLoginFailure({ ip, account, route: '/api/auth/login-password' });
      await pushSecurityAudit({
        userId: user.id,
        account,
        ip,
        path: '/api/auth/login-password',
        action: 'password_login',
        result: 'failed',
        status: 401,
      });
      return NextResponse.json(
        { success: false, message: "账号或密码错误" },
        { status: 401 }
      );
    }

    await resetLoginFailure({ ip, account });
    await pushSecurityAudit({
      userId: user.id,
      account,
      ip,
      path: '/api/auth/login-password',
      action: 'password_login',
      result: 'success',
      status: 200,
    });

    const token = await signSessionToken(user.id);
    const response = NextResponse.json({
      success: true,
      data: {
        id: user.id,
        account: user.account,
        username: user.username,
        role: user.role,
        points: user.points,
        taskBlocked: user.taskBlocked,
        avatarType: user.avatarType,
        avatarValue: user.avatarValue,
      },
    });
    setSessionCookie(response, token);
    return response;
  } catch {
    const ip = getClientIpFromRequest(request);
    await pushSecurityAudit({
      ip,
      path: '/api/auth/login-password',
      action: 'password_login',
      result: 'failed',
      status: 500,
    });
    return NextResponse.json(
      { success: false, message: "登录失败，请稍后重试" },
      { status: 500 }
    );
  }
}
