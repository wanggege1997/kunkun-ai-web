import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSessionUserFromRequest } from '@/lib/server-auth';

export async function GET(request: Request) {
  const user = await getSessionUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ success: false, message: '未登录' }, { status: 401 });
  }

  const state = await prisma.userState.findUnique({ where: { userId: user.id } });
  return NextResponse.json({
    success: true,
    data: {
      history: state ? JSON.parse(state.historyJson || '[]') : [],
      queue: state ? JSON.parse(state.queueJson || '[]') : [],
      updatedAt: state?.updatedAt || null,
    },
  });
}

export async function PUT(request: Request) {
  const user = await getSessionUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ success: false, message: '未登录' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const history = Array.isArray(body.history) ? body.history : [];
  const queue = Array.isArray(body.queue) ? body.queue : [];

  await prisma.userState.upsert({
    where: { userId: user.id },
    create: {
      userId: user.id,
      historyJson: JSON.stringify(history),
      queueJson: JSON.stringify(queue),
    },
    update: {
      historyJson: JSON.stringify(history),
      queueJson: JSON.stringify(queue),
    },
  });

  return NextResponse.json({ success: true });
}
