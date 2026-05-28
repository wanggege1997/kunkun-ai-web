import { NextResponse } from "next/server";
import { getSessionTokenFromCookieHeader, verifySessionToken } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { withCache, cacheKeys } from "@/lib/redis-cache";

export async function GET(request: Request) {
  try {
    const token = getSessionTokenFromCookieHeader(request.headers.get("cookie"));
    if (!token) {
      return NextResponse.json({ success: false }, { status: 401 });
    }

    const payload = await verifySessionToken(token);

    const user = await withCache(
      cacheKeys.user(payload.userId),
      30, // 30秒缓存，积分等变化时会主动失效
      () => prisma.user.findUnique({
        where: { id: payload.userId },
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
      })
    );

    if (!user) {
      return NextResponse.json({ success: false }, { status: 401 });
    }

    return NextResponse.json({ success: true, data: user });
  } catch {
    return NextResponse.json({ success: false, message: "登录状态已失效" }, { status: 401 });
  }
}
