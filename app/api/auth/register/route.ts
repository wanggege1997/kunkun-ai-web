import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";
import {
  randomUsername,
  setSessionCookie,
  signSessionToken,
  validateAccount,
  validatePassword,
} from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { buildSecurityKey, consumeRateLimit, getClientIpFromRequest } from '@/lib/security';
import { SECURITY_POLICY } from '@/lib/security-config';
import { pushSecurityAudit } from '@/lib/risk-control';

async function generateUniqueUsername() {
  for (let i = 0; i < 10; i += 1) {
    const username = randomUsername();
    const exists = await prisma.user.findUnique({ where: { username } });
    if (!exists) return username;
  }
  return `用户${Date.now().toString().slice(-6)}`;
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const account = String(body.account ?? "").trim();
    const password = String(body.password ?? "");
    const ip = getClientIpFromRequest(request);

    const limitResult = await consumeRateLimit({
      key: buildSecurityKey('rl:auth:register', [ip, account || 'empty']),
      limit: SECURITY_POLICY.auth.register.limit,
      windowSec: SECURITY_POLICY.auth.register.windowSec,
    });
    if (!limitResult.allowed) {
      await pushSecurityAudit({
        account,
        ip,
        path: '/api/auth/register',
        action: 'register',
        result: 'rejected',
        status: 429,
      });
      return NextResponse.json(
        { success: false, message: `操作过于频繁，请${limitResult.retryAfterSec}秒后再试` },
        { status: 429 }
      );
    }

    if (!validateAccount(account)) {
      await pushSecurityAudit({
        account,
        ip,
        path: '/api/auth/register',
        action: 'register',
        result: 'failed',
        status: 400,
      });
      return NextResponse.json(
        { success: false, message: "账号必须是8-12位纯数字" },
        { status: 400 }
      );
    }

    if (!validatePassword(password)) {
      await pushSecurityAudit({
        account,
        ip,
        path: '/api/auth/register',
        action: 'register',
        result: 'failed',
        status: 400,
      });
      return NextResponse.json(
        { success: false, message: "密码必须8-20位，且同时包含字母和数字" },
        { status: 400 }
      );
    }

    const exists = await prisma.user.findUnique({ where: { account } });
    if (exists) {
      await pushSecurityAudit({
        account,
        ip,
        path: '/api/auth/register',
        action: 'register',
        result: 'failed',
        status: 409,
      });
      return NextResponse.json(
        { success: false, message: "账号已存在" },
        { status: 409 }
      );
    }

    const username = await generateUniqueUsername();
    const passwordHash = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: { account, passwordHash, username, role: "user", points: 5, taskBlocked: false },
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

    const token = await signSessionToken(user.id);
    await pushSecurityAudit({
      userId: user.id,
      account,
      ip,
      path: '/api/auth/register',
      action: 'register',
      result: 'success',
      status: 200,
    });
    const response = NextResponse.json({ success: true, data: user });
    setSessionCookie(response, token);
    return response;
  } catch {
    const ip = getClientIpFromRequest(request);
    await pushSecurityAudit({
      ip,
      path: '/api/auth/register',
      action: 'register',
      result: 'failed',
      status: 500,
    });
    return NextResponse.json(
      { success: false, message: "注册失败，请稍后重试" },
      { status: 500 }
    );
  }
}
