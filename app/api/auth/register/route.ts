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

    if (!validateAccount(account)) {
      return NextResponse.json(
        { success: false, message: "账号必须是10位纯数字" },
        { status: 400 }
      );
    }

    if (!validatePassword(password)) {
      return NextResponse.json(
        { success: false, message: "密码必须8-10位，且包含字母和数字" },
        { status: 400 }
      );
    }

    const exists = await prisma.user.findUnique({ where: { account } });
    if (exists) {
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
    const response = NextResponse.json({ success: true, data: user });
    setSessionCookie(response, token);
    return response;
  } catch {
    return NextResponse.json(
      { success: false, message: "注册失败，请稍后重试" },
      { status: 500 }
    );
  }
}
