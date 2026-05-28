import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSessionUserFromRequest, isAdminUser } from '@/lib/server-auth';

const NOTICE_SETTING_KEY = 'site_notice_text';
const DEFAULT_NOTICE_TEXT = '平台功能持续升级中，如遇问题请联系顾问';

async function ensureAdmin(request: Request) {
  const user = await getSessionUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ success: false, message: '未登录' }, { status: 401 });
  }
  if (!isAdminUser(user)) {
    return NextResponse.json({ success: false, message: '无管理员权限' }, { status: 403 });
  }
  return null;
}

export async function GET(request: Request) {
  const authError = await ensureAdmin(request);
  if (authError) return authError;

  const setting = await prisma.systemSetting.findUnique({
    where: { key: NOTICE_SETTING_KEY },
    select: { value: true, updatedAt: true },
  });

  return NextResponse.json({
    success: true,
    data: {
      text: (setting?.value || DEFAULT_NOTICE_TEXT).trim(),
      updatedAt: setting?.updatedAt?.toISOString() || null,
    },
  });
}

export async function POST(request: Request) {
  const authError = await ensureAdmin(request);
  if (authError) return authError;

  const body = await request.json().catch(() => ({}));
  const text = String(body?.text || '').trim();

  if (!text) {
    return NextResponse.json({ success: false, message: '通知文案不能为空' }, { status: 400 });
  }

  const saved = await prisma.systemSetting.upsert({
    where: { key: NOTICE_SETTING_KEY },
    create: { key: NOTICE_SETTING_KEY, value: text },
    update: { value: text },
    select: { value: true, updatedAt: true },
  });

  return NextResponse.json({
    success: true,
    data: {
      text: saved.value,
      updatedAt: saved.updatedAt.toISOString(),
    },
  });
}
