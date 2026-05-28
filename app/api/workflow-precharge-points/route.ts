import { NextResponse } from 'next/server';
import { buildWorkflowPrechargePointsMap, getQueueRuntimeConfig, getSyncedWorkflowPrechargePointsMap } from '@/lib/queue-config';
import { workflows } from '@/lib/workflows';

export const dynamic = 'force-dynamic';

export async function GET() {
  const [runtimeConfig, synced] = await Promise.all([
    getQueueRuntimeConfig(),
    getSyncedWorkflowPrechargePointsMap(),
  ]);

  const livePointsMap = buildWorkflowPrechargePointsMap(runtimeConfig);
  const runtimeSecondsMap = Object.fromEntries(
    Object.entries(runtimeConfig.pricing.workflowProfiles || {}).map(([workflowId, profile]) => [
      workflowId,
      Math.max(0, Math.floor(Number(profile?.runtimeSeconds || 0))),
    ])
  );
  const mediaTypeMap = Object.fromEntries(workflows.map((wf) => [wf.workflowId, wf.mediaType]));

  return NextResponse.json(
    {
      success: true,
      data: {
        pointsMap: livePointsMap,
        runtimeSecondsMap,
        mediaTypeMap,
        syncedAt: synced?.syncedAt ?? null,
        source: 'live-config',
      },
    },
    {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        Pragma: 'no-cache',
        Expires: '0',
      },
    }
  );
}
