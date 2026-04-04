import bcrypt from 'bcryptjs';
import { NextResponse } from 'next/server';
import {
  getSessionTokenFromCookieHeader,
  validatePassword,
  verifySessionToken,
} from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export async function PATCH(request: Request) {
  try {
    const token = getSessionTokenFromCookieHeader(request.headers.get('cookie'));
    if (!token) {
      return NextResponse.json({ success: false }, { status: 401 });
    }

    const payload = await verifySessionToken(token);
    const body = await request.json();
    const currentPassword = String(body.currentPassword ?? '');
    const newPassword = String(body.newPassword ?? '');

    if (!currentPassword) {
      return NextResponse.json(
        { success: false, message: '请输入当前密码' },
        { status: 400 }
      );
    }

    if (!validatePassword(newPassword)) {
      return NextResponse.json(
        { success: false, message: '新密码必须8-10位，且包含字母和数字' },
        { status: 400 }
      );
    }

    const user = await prisma.user.findUnique({ where: { id: payload.userId } });
    if (!user) {
      return NextResponse.json({ success: false }, { status: 401 });
    }

    const ok = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!ok) {
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

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { success: false, message: '修改密码失败' },
      { status: 500 }
    );
  }
}
