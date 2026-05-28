import { NextResponse } from 'next/server';
import { getSessionUserFromRequest, isAdminUser } from '@/lib/server-auth';
import {
  getQueueRuntimeConfig,
  getQueueConcurrencyRuntimeSnapshot,
  setQueueRuntimeConfig,
  type QueueRuntimeConfig,
  type WorkflowInstanceType,
  type WorkflowPricingProfile,
} from '@/lib/queue-config';

function normalizeMs(value: unknown, fallback: number) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function normalizePositiveInt(value: unknown, fallback: number) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function normalizePositiveNumber(value: unknown, fallback: number, min = 0) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= min) return fallback;
  return n;
}

function normalizePercent(value: unknown, fallback: number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(99, Math.max(0, n));
}

function normalizeInstanceType(value: unknown, fallback: WorkflowInstanceType): WorkflowInstanceType {
  if (value === 'lite' || value === 'default' || value === 'plus') return value;
  return fallback;
}

export async function GET(request: Request) {
  const user = await getSessionUserFromRequest(request);
  if (!isAdminUser(user)) {
    return NextResponse.json({ success: false, message: '无管理员权限' }, { status: 403 });
  }

  const config = await getQueueRuntimeConfig();
  const runtime = await getQueueConcurrencyRuntimeSnapshot();
  return NextResponse.json({ success: true, data: { config, runtime } });
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

  const incomingConcurrency = body?.concurrency;
  const minLimit = normalizePositiveInt(incomingConcurrency?.minLimit, current.concurrency.minLimit);
  const maxLimitRaw = normalizePositiveInt(incomingConcurrency?.maxLimit, current.concurrency.maxLimit);
  const maxLimit = Math.max(minLimit, maxLimitRaw);
  const baseLimitRaw = normalizePositiveInt(incomingConcurrency?.baseLimit, current.concurrency.baseLimit);
  const baseLimit = Math.min(maxLimit, Math.max(minLimit, baseLimitRaw));

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
    concurrency: {
      enabled: incomingConcurrency?.enabled !== false,
      baseLimit,
      minLimit,
      maxLimit,
      scaleDownStep: normalizePositiveInt(incomingConcurrency?.scaleDownStep, current.concurrency.scaleDownStep),
      scaleUpStep: normalizePositiveInt(incomingConcurrency?.scaleUpStep, current.concurrency.scaleUpStep),
      scaleUpCoolDownMs: normalizeMs(incomingConcurrency?.scaleUpCoolDownMs, current.concurrency.scaleUpCoolDownMs),
    },
    pricing: {
      runningCostYuanPerHour: normalizePositiveNumber(
        body?.pricing?.runningCostYuanPerHour,
        current.pricing.runningCostYuanPerHour
      ),
      successChargeMultiplier: normalizePositiveNumber(
        body?.pricing?.successChargeMultiplier,
        current.pricing.successChargeMultiplier,
        -1
      ),
      failedChargeMultiplier: normalizePositiveNumber(
        body?.pricing?.failedChargeMultiplier,
        current.pricing.failedChargeMultiplier,
        -1
      ),
      cancelRunningChargeMultiplier: normalizePositiveNumber(
        body?.pricing?.cancelRunningChargeMultiplier,
        current.pricing.cancelRunningChargeMultiplier,
        -1
      ),
      cancelRunningSafetyFactor: normalizePositiveNumber(
        body?.pricing?.cancelRunningSafetyFactor,
        current.pricing.cancelRunningSafetyFactor,
        0.9999
      ),
      cancelRunningMinChargePoints: normalizePositiveInt(
        body?.pricing?.cancelRunningMinChargePoints,
        current.pricing.cancelRunningMinChargePoints
      ),
      rhCoinToYuan: normalizePositiveNumber(
        body?.pricing?.rhCoinToYuan,
        current.pricing.rhCoinToYuan
      ),
      instanceHourlyCost: {
        lite: normalizePositiveNumber(
          body?.pricing?.instanceHourlyCost?.lite,
          current.pricing.instanceHourlyCost.lite
        ),
        default: normalizePositiveNumber(
          body?.pricing?.instanceHourlyCost?.default,
          current.pricing.instanceHourlyCost.default
        ),
        plus: normalizePositiveNumber(
          body?.pricing?.instanceHourlyCost?.plus,
          current.pricing.instanceHourlyCost.plus
        ),
      },
      defaultGrossMarginPercent: normalizePercent(
        body?.pricing?.defaultGrossMarginPercent,
        current.pricing.defaultGrossMarginPercent
      ),
      workflowProfiles: (() => {
        const source = body?.pricing?.workflowProfiles;
        const result: Record<string, WorkflowPricingProfile> = {};
        if (!source || typeof source !== 'object') {
          return current.pricing.workflowProfiles;
        }
        for (const [workflowId, raw] of Object.entries(source as Record<string, unknown>)) {
          const currentProfile = current.pricing.workflowProfiles[workflowId] || {
            runtimeSeconds: 0,
            extraCostYuan: 0,
            extraCostRhCoins: 0,
            instanceType: 'lite' as WorkflowInstanceType,
            grossMarginPercent: current.pricing.defaultGrossMarginPercent,
          };
          const item = raw as Partial<WorkflowPricingProfile> | undefined;
          result[workflowId] = {
            runtimeSeconds: Math.max(0, Number(item?.runtimeSeconds ?? currentProfile.runtimeSeconds)),
            extraCostYuan: Math.max(0, Number(item?.extraCostYuan ?? currentProfile.extraCostYuan)),
            extraCostRhCoins: Math.max(0, Number(item?.extraCostRhCoins ?? currentProfile.extraCostRhCoins)),
            instanceType: normalizeInstanceType(item?.instanceType, currentProfile.instanceType),
            grossMarginPercent: normalizePercent(item?.grossMarginPercent, currentProfile.grossMarginPercent),
          };
        }
        return result;
      })(),
    },
  };

  await setQueueRuntimeConfig(next);
  const runtime = await getQueueConcurrencyRuntimeSnapshot();
  return NextResponse.json({ success: true, data: { config: next, runtime } });
}
