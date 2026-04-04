import { NextResponse } from 'next/server';
import { getSessionUserFromRequest, isAdminUser } from '@/lib/server-auth';
import { getQueueRuntimeConfig, setQueueRuntimeConfig, type QueueRuntimeConfig } from '@/lib/queue-config';

function normalizeMs(value: unknown, fallback: number) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

export async function GET(request: Request) {
  const user = await getSessionUserFromRequest(request);
  if (!isAdminUser(user)) {
    return NextResponse.json({ success: false, message: '无管理员权限' }, { status: 403 });
  }

  const config = await getQueueRuntimeConfig();
  return NextResponse.json({ success: true, data: config });
}

export async function POST(request: Request) {
  const user = await getSessionUserFromRequest(request);
  if (!isAdminUser(user)) {
    return NextResponse.json({ success: false, message: '无管理员权限' }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const current = await getQueueRuntimeConfig();

  const timeoutDefaults = {
    imageMs: normalizeMs(body?.timeoutDefaults?.imageMs, current.timeoutDefaults.imageMs),
    audioMs: normalizeMs(body?.timeoutDefaults?.audioMs, current.timeoutDefaults.audioMs),
    videoMs: normalizeMs(body?.timeoutDefaults?.videoMs, current.timeoutDefaults.videoMs),
  };

  const overridesSource = body?.workflowTimeoutOverrides;
  const workflowTimeoutOverrides: Record<string, number> = {};
  if (overridesSource && typeof overridesSource === 'object') {
    for (const [key, value] of Object.entries(overridesSource as Record<string, unknown>)) {
      const ms = normalizeMs(value, 0);
      if (ms > 0) workflowTimeoutOverrides[key] = ms;
    }
  }

  const next: QueueRuntimeConfig = {
    timeoutDefaults,
    workflowTimeoutOverrides,
    heartbeatToleranceMs: normalizeMs(body?.heartbeatToleranceMs, current.heartbeatToleranceMs),
    refundPolicy: {
      submitFailed: body?.refundPolicy?.submitFailed === 'none' ? 'none' : 'full',
      taskFailed: body?.refundPolicy?.taskFailed === 'none' ? 'none' : 'full',
      taskTimeout: body?.refundPolicy?.taskTimeout === 'none' ? 'none' : 'full',
      payloadInvalid: body?.refundPolicy?.payloadInvalid === 'none' ? 'none' : 'full',
    },
    delivery: {
      retryIntervalMs: normalizeMs(body?.delivery?.retryIntervalMs, current.delivery.retryIntervalMs),
      maxAttempts: normalizeMs(body?.delivery?.maxAttempts, current.delivery.maxAttempts),
      verifyTimeoutMs: normalizeMs(body?.delivery?.verifyTimeoutMs, current.delivery.verifyTimeoutMs),
    },
  };

  await setQueueRuntimeConfig(next);
  return NextResponse.json({ success: true, data: next });
}
