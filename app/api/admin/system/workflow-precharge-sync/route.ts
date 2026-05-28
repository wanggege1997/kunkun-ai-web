import { NextResponse } from 'next/server';
import { getSessionUserFromRequest, isAdminUser } from '@/lib/server-auth';
import { getSyncedWorkflowPrechargePointsMap, syncWorkflowPrechargePointsFromConfig } from '@/lib/queue-config';

export async function GET(request: Request) {
  const user = await getSessionUserFromRequest(request);
  if (!isAdminUser(user)) {
    return NextResponse.json({ success: false, message: '无管理员权限' }, { status: 403 });
  }

  const data = await getSyncedWorkflowPrechargePointsMap();
  return NextResponse.json({ success: true, data });
}

export async function POST(request: Request) {
  const user = await getSessionUserFromRequest(request);
  if (!isAdminUser(user)) {
    return NextResponse.json({ success: false, message: '无管理员权限' }, { status: 403 });
  }

  const data = await syncWorkflowPrechargePointsFromConfig();
  return NextResponse.json({
    success: true,
    data: {
      syncedAt: data.syncedAt,
      workflowCount: Object.keys(data.pointsMap || {}).length,
      pointsMap: data.pointsMap,
    },
  });
}
