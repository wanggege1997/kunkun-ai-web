import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET() {
  const settings = await prisma.systemSetting.findMany({
    where: { key: { startsWith: 'workflow_disabled_' } },
  });

  const list = settings
    .map((s) => {
      const workflowId = s.key.replace('workflow_disabled_', '');
      let parsed: { disabled?: boolean; reason?: string; disabledAt?: string } = {};
      try {
        parsed = JSON.parse(s.value);
      } catch {
        parsed = {};
      }
      return {
        workflowId,
        disabled: parsed.disabled ?? true,
        reason: parsed.reason ?? '',
        disabledAt: parsed.disabledAt ?? '',
      };
    })
    .filter((item) => item.disabled);

  return NextResponse.json({ success: true, data: list });
}
