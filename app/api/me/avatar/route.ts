import { NextResponse } from "next/server";
import { getSessionTokenFromCookieHeader, verifySessionToken } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const DEFAULT_AVATAR_KEYS = new Set([
  "ocean",
  "sunset",
  "leaf",
  "violet",
  "ember",
  "graphite",
]);

const DATA_URL_RE = /^data:image\/(png|jpeg|jpg|webp|gif);base64,[a-zA-Z0-9+/=]+$/;
const MAX_AVATAR_DATA_URL_LENGTH = 1_500_000;

export async function PATCH(request: Request) {
  try {
    const token = getSessionTokenFromCookieHeader(request.headers.get("cookie"));
    if (!token) {
      return NextResponse.json({ success: false }, { status: 401 });
    }

    const payload = await verifySessionToken(token);
    const body = await request.json().catch(() => ({}));
    const mode = String(body?.mode || "").trim();
    const value = String(body?.value || "").trim();

    if (mode !== "default" && mode !== "upload") {
      return NextResponse.json({ success: false, message: "头像模式无效" }, { status: 400 });
    }

    const safeDefaultValue = DEFAULT_AVATAR_KEYS.has(value) ? value : "ocean";

    if (mode === "upload") {
      if (!value) {
        return NextResponse.json({ success: false, message: "请先上传头像图片" }, { status: 400 });
      }
      if (value.length > MAX_AVATAR_DATA_URL_LENGTH) {
        return NextResponse.json({ success: false, message: "头像图片过大，请选择 1MB 以内图片" }, { status: 400 });
      }
      if (!DATA_URL_RE.test(value)) {
        return NextResponse.json({ success: false, message: "仅支持 PNG/JPG/WEBP/GIF 图片" }, { status: 400 });
      }
    }

    const user = await prisma.user.update({
      where: { id: payload.userId },
      data: {
        avatarType: mode,
        avatarValue: mode === "default" ? safeDefaultValue : value,
      },
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
    return NextResponse.json({ success: false, message: "修改头像失败" }, { status: 500 });
  }
}
