import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";
import {
  setSessionCookie,
  signSessionToken,
  validateAccount,
  validatePassword,
} from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const account = String(body.account ?? "").trim();
    const password = String(body.password ?? "");

    if (!validateAccount(account) || !validatePassword(password)) {
      return NextResponse.json(
        { success: false, message: "账号或密码格式不正确" },
        { status: 400 }
      );
    }

    const user = await prisma.user.findUnique({ where: { account } });
    if (!user) {
      return NextResponse.json(
        { success: false, message: "账号或密码错误" },
        { status: 401 }
      );
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return NextResponse.json(
        { success: false, message: "账号或密码错误" },
        { status: 401 }
      );
    }

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
    return NextResponse.json(
      { success: false, message: "登录失败，请稍后重试" },
      { status: 500 }
    );
  }
}
