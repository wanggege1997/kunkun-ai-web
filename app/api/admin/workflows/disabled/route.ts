import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSessionUserFromRequest, isAdminUser } from '@/lib/server-auth';

/**
 * GET /api/admin/workflows/disabled
 * 查询所有已被全局禁用的AI应用
 *
 * POST /api/admin/workflows/disabled
 * Body: { workflowId: string, action: 'enable' | 'disable', reason?: string }
 * 管理员手动启用或禁用某个AI应用
 */
export async function GET(request: Request) {
  const sessionUser = await getSessionUserFromRequest(request);
  if (!isAdminUser(sessionUser)) {
    return NextResponse.json({ success: false, message: '无管理员权限' }, { status: 403 });
  }

  const settings = await prisma.systemSetting.findMany({
    where: { key: { startsWith: 'workflow_disabled_' } },
  });

  const list = settings.map((s) => {
    const workflowId = s.key.replace('workflow_disabled_', '');
    let parsed: { disabled?: boolean; reason?: string; disabledAt?: string } = {};
    try { parsed = JSON.parse(s.value); } catch { /* ignore */ }
    return {
      workflowId,
      disabled: parsed.disabled ?? true,
      reason: parsed.reason ?? '',
      disabledAt: parsed.disabledAt ?? '',
    };
  }).filter((item) => item.disabled);

  return NextResponse.json({ success: true, data: list });
}

export async function POST(request: Request) {
  const sessionUser = await getSessionUserFromRequest(request);
  if (!isAdminUser(sessionUser)) {
    return NextResponse.json({ success: false, message: '无管理员权限' }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const workflowId = String(body.workflowId || '').trim();
  const action = String(body.action || '').trim() as 'enable' | 'disable';
  const reason = String(body.reason || '').trim() || (action === 'disable' ? '管理员手动禁用' : '');

  if (!workflowId) {
    return NextResponse.json({ success: false, message: '缺少 workflowId' }, { status: 400 });
  }
  if (!['enable', 'disable'].includes(action)) {
    return NextResponse.json({ success: false, message: 'action 必须是 enable 或 disable' }, { status: 400 });
  }

  const key = `workflow_disabled_${workflowId}`;

  if (action === 'enable') {
    await prisma.systemSetting.delete({ where: { key } }).catch(() => undefined);
    return NextResponse.json({ success: true, message: 'AI应用已重新启用', data: { workflowId, disabled: false } });
  }

  // action === 'disable'
  await prisma.systemSetting.upsert({
    where: { key },
    create: { key, value: JSON.stringify({ disabled: true, reason, disabledAt: new Date().toISOString() }) },
    update: { value: JSON.stringify({ disabled: true, reason, disabledAt: new Date().toISOString() }) },
  });

  return NextResponse.json({ success: true, message: 'AI应用已禁用', data: { workflowId, disabled: true, reason } });
}
