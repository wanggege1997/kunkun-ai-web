import { NextResponse } from 'next/server';
import { getSessionUserFromRequest, isAdminUser } from '@/lib/server-auth';
import { getSecurityAuditEvents } from '@/lib/risk-control';

export async function GET(request: Request) {
  const user = await getSessionUserFromRequest(request);
  if (!isAdminUser(user)) {
    return NextResponse.json({ success: false, message: '无管理员权限' }, { status: 403 });
  }

  const url = new URL(request.url);
  const limitRaw = Number(url.searchParams.get('limit') || 30);
  const limit = Math.min(200, Math.max(1, Math.floor(limitRaw)));
  const action = String(url.searchParams.get('action') || '').trim();

  const rows = await getSecurityAuditEvents(limit, action || undefined);
  return NextResponse.json({ success: true, data: rows });
}
