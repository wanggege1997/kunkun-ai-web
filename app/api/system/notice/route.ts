import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

const NOTICE_SETTING_KEY = 'site_notice_text';
const DEFAULT_NOTICE_TEXT = '平台功能持续升级中，如遇问题请联系顾问';

export async function GET() {
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
