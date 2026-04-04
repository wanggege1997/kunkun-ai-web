import { NextResponse } from "next/server";
import {
  getSessionTokenFromCookieHeader,
  validateUsername,
  verifySessionToken,
} from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function PATCH(request: Request) {
  try {
    const token = getSessionTokenFromCookieHeader(request.headers.get("cookie"));
    if (!token) {
      return NextResponse.json({ success: false }, { status: 401 });
    }

    const payload = await verifySessionToken(token);
    const body = await request.json();
    const username = String(body.username ?? "").trim();

    if (!validateUsername(username)) {
      return NextResponse.json(
        { success: false, message: "用户名需1-12位，中英文/数字/下划线" },
        { status: 400 }
      );
    }

    const existed = await prisma.user.findUnique({ where: { username } });
    if (existed && existed.id !== payload.userId) {
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

    return NextResponse.json({ success: true, data: user });
  } catch {
    return NextResponse.json(
      { success: false, message: "修改用户名失败" },
      { status: 500 }
    );
  }
}
