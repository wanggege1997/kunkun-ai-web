import { NextResponse } from "next/server";
import { getSessionUserFromRequest, isAdminUser } from '@/lib/server-auth';

export async function POST(request: Request) {
  const user = await getSessionUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ success: false, message: '未登录' }, { status: 401 });
  }

  if (!isAdminUser(user)) {
    return NextResponse.json({ success: false, message: '无管理员权限' }, { status: 403 });
  }

  return NextResponse.json({ success: true });
}
