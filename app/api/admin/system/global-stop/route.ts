import { NextResponse } from 'next/server';
import { getGlobalStopEnabled, setGlobalStopEnabled } from '@/lib/points';
import { getSessionUserFromRequest, isAdminUser } from '@/lib/server-auth';

export async function GET(request: Request) {
  const sessionUser = await getSessionUserFromRequest(request);
  if (!isAdminUser(sessionUser)) {
    return NextResponse.json({ success: false, message: '无管理员权限' }, { status: 403 });
  }

  const enabled = await getGlobalStopEnabled();
  return NextResponse.json({ success: true, data: { enabled } });
}

export async function POST(request: Request) {
  const sessionUser = await getSessionUserFromRequest(request);
  if (!isAdminUser(sessionUser)) {
    return NextResponse.json({ success: false, message: '无管理员权限' }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const enabled = Boolean(body.enabled);
  await setGlobalStopEnabled(enabled);
  return NextResponse.json({ success: true, data: { enabled } });
}
