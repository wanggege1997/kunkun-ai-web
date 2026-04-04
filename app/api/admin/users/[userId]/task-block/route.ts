import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSessionUserFromRequest, isAdminUser } from '@/lib/server-auth';

export async function POST(
  request: Request,
  context: { params: Promise<{ userId: string }> }
) {
  const sessionUser = await getSessionUserFromRequest(request);
  if (!isAdminUser(sessionUser)) {
    return NextResponse.json({ success: false, message: '无管理员权限' }, { status: 403 });
  }

  const { userId } = await context.params;
  const body = await request.json().catch(() => ({}));
  const blocked = Boolean(body.blocked);

  const target = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true },
  });

  if (!target) {
    return NextResponse.json({ success: false, message: '用户不存在' }, { status: 404 });
  }

  if (target.role === 'admin' && blocked) {
    return NextResponse.json({ success: false, message: '管理员账号不能被暂停任务' }, { status: 400 });
  }

  const user = await prisma.user.update({
    where: { id: userId },
    data: { taskBlocked: blocked },
    select: { id: true, taskBlocked: true },
  });

  return NextResponse.json({ success: true, data: user });
}
