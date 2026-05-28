import { prisma } from '@/lib/prisma';
import { workflows } from '@/lib/workflows';

export type RefundPolicy = 'none' | 'full';
export type WorkflowInstanceType = 'lite' | 'default' | 'plus';

export type WorkflowPricingProfile = {
  runtimeSeconds: number;
  extraCostYuan: number;
  extraCostRhCoins: number;
  instanceType: WorkflowInstanceType;
  grossMarginPercent: number;
};

export type QueueRuntimeConfig = {
  timeoutDefaults: {
    imageMs: number;
    audioMs: number;
    videoMs: number;
  };
  workflowTimeoutOverrides: Record<string, number>;
  heartbeatToleranceMs: number;
  refundPolicy: {
    submitFailed: RefundPolicy;
    taskFailed: RefundPolicy;
    taskTimeout: RefundPolicy;
    payloadInvalid: RefundPolicy;
  };
  delivery: {
    retryIntervalMs: number;
    maxAttempts: number;
    verifyTimeoutMs: number;
  };
  concurrency: {
    enabled: boolean;
    baseLimit: number;
    minLimit: number;
    maxLimit: number;
    scaleDownStep: number;
    scaleUpStep: number;
    scaleUpCoolDownMs: number;
  };
  pricing: {
    runningCostYuanPerHour: number;
    successChargeMultiplier: number;
    failedChargeMultiplier: number;
    cancelRunningChargeMultiplier: number;
    cancelRunningSafetyFactor: number;
    cancelRunningMinChargePoints: number;
    rhCoinToYuan: number;
    instanceHourlyCost: {
      lite: number;
      default: number;
      plus: number;
    };
    defaultGrossMarginPercent: number;
    workflowProfiles: Record<string, WorkflowPricingProfile>;
  };
};

function toWorkflowInstanceType(value: unknown, fallback: WorkflowInstanceType): WorkflowInstanceType {
  if (value === 'lite' || value === 'default' || value === 'plus') return value;
  return fallback;
}

function toGrossMarginPercent(value: unknown, fallback: number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(99, Math.max(0, n));
}

function buildDefaultWorkflowProfiles(defaultGrossMarginPercent: number): Record<string, WorkflowPricingProfile> {
  const records: Record<string, WorkflowPricingProfile> = {};
  for (const wf of workflows) {
    records[wf.workflowId] = {
      runtimeSeconds: Math.max(0, Number(wf.runtimeSeconds || 0)),
      extraCostYuan: Math.max(0, Number(wf.extraCostYuan || 0)),
      extraCostRhCoins: Math.max(0, Number(wf.extraCostRhCoins || 0)),
      instanceType: wf.mediaType === 'video' ? 'plus' : 'lite',
      grossMarginPercent: defaultGrossMarginPercent,
    };
  }

  // 历史兼容 ID（不在当前 workflows 列表中）
  if (!records['2036111341429202945']) {
    records['2036111341429202945'] = {
      runtimeSeconds: 20 * 60,
      extraCostYuan: 0,
      extraCostRhCoins: 9,
      instanceType: 'lite',
      grossMarginPercent: defaultGrossMarginPercent,
    };
  }
  if (!records['2037199977641938945']) {
    records['2037199977641938945'] = {
      runtimeSeconds: 40,
      extraCostYuan: 0,
      extraCostRhCoins: 14,
      instanceType: 'lite',
      grossMarginPercent: defaultGrossMarginPercent,
    };
  }

  return records;
}

type QueueConcurrencyRuntimeState = {
  currentLimit: number;
  lastScaledAt: number;
  lastSignal: 'init' | 'throttle' | 'success_batch';
  updatedAt: number;
};

const DEFAULT_CONFIG: QueueRuntimeConfig = {
  timeoutDefaults: {
    imageMs: 10 * 60 * 1000,
    audioMs: 50 * 60 * 1000,
    videoMs: 60 * 60 * 1000,
  },
  workflowTimeoutOverrides: {},
  heartbeatToleranceMs: 8 * 60 * 1000,
  refundPolicy: {
    submitFailed: 'full',
    taskFailed: 'full',
    taskTimeout: 'full',
    payloadInvalid: 'full',
  },
  delivery: {
    retryIntervalMs: 20 * 1000,
    maxAttempts: 6,
    verifyTimeoutMs: 10 * 1000,
  },
  concurrency: {
    enabled: true,
    baseLimit: 80,
    minLimit: 40,
    maxLimit: 90,
    scaleDownStep: 5,
    scaleUpStep: 2,
    scaleUpCoolDownMs: 2 * 60 * 1000,
  },
  pricing: {
    runningCostYuanPerHour: 6,
    successChargeMultiplier: 4.7,
    failedChargeMultiplier: 4.4,
    cancelRunningChargeMultiplier: 3.6,
    cancelRunningSafetyFactor: 1.03,
    cancelRunningMinChargePoints: 10,
    rhCoinToYuan: 10 / 2500,
    instanceHourlyCost: {
      lite: 0.4,
      default: 4,
      plus: 6,
    },
    defaultGrossMarginPercent: 78,
    workflowProfiles: buildDefaultWorkflowProfiles(78),
  },
};

const CONFIG_KEY = 'queue_runtime_config_v1';
const CONCURRENCY_STATE_KEY = 'queue_dynamic_concurrency_state_v1';
const WORKFLOW_PRECHARGE_POINTS_KEY = 'workflow_precharge_points_v1';

function toPositiveInt(value: unknown, fallback: number) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function marginPercentToMultiplier(marginPercent: number) {
  const safeMargin = Math.min(99, Math.max(0, Number(marginPercent || 0)));
  const ratio = 1 - safeMargin / 100;
  if (ratio <= 0) return 0;
  return 1 / ratio;
}

export async function getQueueRuntimeConfig(): Promise<QueueRuntimeConfig> {
  const row = await prisma.systemSetting.findUnique({ where: { key: CONFIG_KEY } });
  if (!row) return DEFAULT_CONFIG;

  try {
    const parsed = JSON.parse(row.value) as Partial<QueueRuntimeConfig>;
    const parsedConcurrency = parsed?.concurrency;
    const defaultGrossMarginPercent = toGrossMarginPercent(
      parsed?.pricing?.defaultGrossMarginPercent,
      DEFAULT_CONFIG.pricing.defaultGrossMarginPercent
    );
    const fallbackProfiles = buildDefaultWorkflowProfiles(defaultGrossMarginPercent);
    const incomingProfiles = parsed?.pricing?.workflowProfiles;
    const normalizedProfiles: Record<string, WorkflowPricingProfile> = { ...fallbackProfiles };
    if (incomingProfiles && typeof incomingProfiles === 'object') {
      for (const [workflowId, rawProfile] of Object.entries(incomingProfiles as Record<string, unknown>)) {
        const next = rawProfile as Partial<WorkflowPricingProfile> | undefined;
        const fallback = fallbackProfiles[workflowId] || {
          runtimeSeconds: 0,
          extraCostYuan: 0,
          extraCostRhCoins: 0,
          instanceType: 'lite' as WorkflowInstanceType,
          grossMarginPercent: defaultGrossMarginPercent,
        };
        normalizedProfiles[workflowId] = {
          runtimeSeconds: Math.max(0, Number(next?.runtimeSeconds ?? fallback.runtimeSeconds)),
          extraCostYuan: Math.max(0, Number(next?.extraCostYuan ?? fallback.extraCostYuan)),
          extraCostRhCoins: Math.max(0, Number(next?.extraCostRhCoins ?? fallback.extraCostRhCoins)),
          instanceType: toWorkflowInstanceType(next?.instanceType, fallback.instanceType),
          grossMarginPercent: toGrossMarginPercent(next?.grossMarginPercent, fallback.grossMarginPercent),
        };
      }
    }
    const minLimit = toPositiveInt(parsedConcurrency?.minLimit, DEFAULT_CONFIG.concurrency.minLimit);
    const maxLimitRaw = toPositiveInt(parsedConcurrency?.maxLimit, DEFAULT_CONFIG.concurrency.maxLimit);
    const maxLimit = Math.max(minLimit, maxLimitRaw);
    const baseLimitRaw = toPositiveInt(parsedConcurrency?.baseLimit, DEFAULT_CONFIG.concurrency.baseLimit);
    const baseLimit = Math.min(maxLimit, Math.max(minLimit, baseLimitRaw));

    return {
      timeoutDefaults: {
        imageMs: toPositiveInt(parsed?.timeoutDefaults?.imageMs, DEFAULT_CONFIG.timeoutDefaults.imageMs),
        audioMs: toPositiveInt(parsed?.timeoutDefaults?.audioMs, DEFAULT_CONFIG.timeoutDefaults.audioMs),
        videoMs: toPositiveInt(parsed?.timeoutDefaults?.videoMs, DEFAULT_CONFIG.timeoutDefaults.videoMs),
      },
      workflowTimeoutOverrides:
        parsed?.workflowTimeoutOverrides && typeof parsed.workflowTimeoutOverrides === 'object'
          ? Object.fromEntries(
              Object.entries(parsed.workflowTimeoutOverrides).map(([key, value]) => [key, toPositiveInt(value, 0)])
            )
          : {},
      heartbeatToleranceMs: toPositiveInt(parsed?.heartbeatToleranceMs, DEFAULT_CONFIG.heartbeatToleranceMs),
      refundPolicy: {
        submitFailed: parsed?.refundPolicy?.submitFailed === 'none' ? 'none' : 'full',
        taskFailed: parsed?.refundPolicy?.taskFailed === 'none' ? 'none' : 'full',
        taskTimeout: parsed?.refundPolicy?.taskTimeout === 'none' ? 'none' : 'full',
        payloadInvalid: parsed?.refundPolicy?.payloadInvalid === 'none' ? 'none' : 'full',
      },
      delivery: {
        retryIntervalMs: toPositiveInt(parsed?.delivery?.retryIntervalMs, DEFAULT_CONFIG.delivery.retryIntervalMs),
        maxAttempts: toPositiveInt(parsed?.delivery?.maxAttempts, DEFAULT_CONFIG.delivery.maxAttempts),
        verifyTimeoutMs: toPositiveInt(parsed?.delivery?.verifyTimeoutMs, DEFAULT_CONFIG.delivery.verifyTimeoutMs),
      },
      concurrency: {
        enabled: parsedConcurrency?.enabled !== false,
        minLimit,
        maxLimit,
        baseLimit,
        scaleDownStep: toPositiveInt(parsedConcurrency?.scaleDownStep, DEFAULT_CONFIG.concurrency.scaleDownStep),
        scaleUpStep: toPositiveInt(parsedConcurrency?.scaleUpStep, DEFAULT_CONFIG.concurrency.scaleUpStep),
        scaleUpCoolDownMs: toPositiveInt(parsedConcurrency?.scaleUpCoolDownMs, DEFAULT_CONFIG.concurrency.scaleUpCoolDownMs),
      },
      pricing: {
        runningCostYuanPerHour: Math.max(
          0.0001,
          Number(parsed?.pricing?.runningCostYuanPerHour ?? DEFAULT_CONFIG.pricing.runningCostYuanPerHour)
        ),
        successChargeMultiplier: Math.max(
          0,
          Number(parsed?.pricing?.successChargeMultiplier ?? DEFAULT_CONFIG.pricing.successChargeMultiplier)
        ),
        failedChargeMultiplier: Math.max(
          0,
          Number(parsed?.pricing?.failedChargeMultiplier ?? DEFAULT_CONFIG.pricing.failedChargeMultiplier)
        ),
        cancelRunningChargeMultiplier: Math.max(
          0,
          Number(parsed?.pricing?.cancelRunningChargeMultiplier ?? DEFAULT_CONFIG.pricing.cancelRunningChargeMultiplier)
        ),
        cancelRunningSafetyFactor: Math.max(
          1,
          Number(parsed?.pricing?.cancelRunningSafetyFactor ?? DEFAULT_CONFIG.pricing.cancelRunningSafetyFactor)
        ),
        cancelRunningMinChargePoints: toPositiveInt(
          parsed?.pricing?.cancelRunningMinChargePoints,
          DEFAULT_CONFIG.pricing.cancelRunningMinChargePoints
        ),
        rhCoinToYuan: Math.max(0.000001, Number(parsed?.pricing?.rhCoinToYuan ?? DEFAULT_CONFIG.pricing.rhCoinToYuan)),
        instanceHourlyCost: {
          lite: Math.max(0.0001, Number(parsed?.pricing?.instanceHourlyCost?.lite ?? DEFAULT_CONFIG.pricing.instanceHourlyCost.lite)),
          default: Math.max(0.0001, Number(parsed?.pricing?.instanceHourlyCost?.default ?? DEFAULT_CONFIG.pricing.instanceHourlyCost.default)),
          plus: Math.max(0.0001, Number(parsed?.pricing?.instanceHourlyCost?.plus ?? DEFAULT_CONFIG.pricing.instanceHourlyCost.plus)),
        },
        defaultGrossMarginPercent,
        workflowProfiles: normalizedProfiles,
      },
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export async function setQueueRuntimeConfig(input: QueueRuntimeConfig) {
  await prisma.systemSetting.upsert({
    where: { key: CONFIG_KEY },
    create: { key: CONFIG_KEY, value: JSON.stringify(input) },
    update: { value: JSON.stringify(input) },
  });
}

export function buildWorkflowPrechargePointsMap(config: QueueRuntimeConfig): Record<string, number> {
  const rhCoinToYuan = Math.max(0.000001, Number(config.pricing.rhCoinToYuan || 0.004));
  const safeFactor = Math.max(1, Number(config.pricing.cancelRunningSafetyFactor || 1));
  const minCharge = Math.max(0, Math.floor(Number(config.pricing.cancelRunningMinChargePoints || 0)));
  const pointsMap: Record<string, number> = {};

  for (const [workflowId, profile] of Object.entries(config.pricing.workflowProfiles || {})) {
    const runtimeSeconds = Math.max(0, Number(profile.runtimeSeconds || 0));
    const extraCostYuan = Math.max(0, Number(profile.extraCostYuan || 0));
    const extraCostRhCoins = Math.max(0, Number(profile.extraCostRhCoins || 0));
    const instanceType = profile.instanceType;

    const hourlyCost = instanceType === 'default'
      ? Math.max(0, Number(config.pricing.instanceHourlyCost.default || 0))
      : instanceType === 'plus'
        ? Math.max(0, Number(config.pricing.instanceHourlyCost.plus || 0))
        : Math.max(0, Number(config.pricing.instanceHourlyCost.lite || 0));

    const serverCostYuan = (runtimeSeconds / 3600) * hourlyCost;
    const rhCostYuan = extraCostRhCoins * rhCoinToYuan;
    const totalCostYuan = serverCostYuan + rhCostYuan + extraCostYuan;

    const multiplier = marginPercentToMultiplier(profile.grossMarginPercent);
    const costPoints = Math.ceil(totalCostYuan * 100 * safeFactor);
    const prechargePoints = Math.max(minCharge, Math.ceil(costPoints * multiplier));
    pointsMap[workflowId] = Math.max(0, prechargePoints);
  }

  return pointsMap;
}

export async function syncWorkflowPrechargePointsFromConfig() {
  const config = await getQueueRuntimeConfig();
  const pointsMap = buildWorkflowPrechargePointsMap(config);
  const payload = {
    pointsMap,
    syncedAt: Date.now(),
  };
  await prisma.systemSetting.upsert({
    where: { key: WORKFLOW_PRECHARGE_POINTS_KEY },
    create: { key: WORKFLOW_PRECHARGE_POINTS_KEY, value: JSON.stringify(payload) },
    update: { value: JSON.stringify(payload) },
  });
  return payload;
}

export async function getSyncedWorkflowPrechargePointsMap(): Promise<{ pointsMap: Record<string, number>; syncedAt: number | null }> {
  const row = await prisma.systemSetting.findUnique({ where: { key: WORKFLOW_PRECHARGE_POINTS_KEY } });
  if (!row) {
    return { pointsMap: {}, syncedAt: null };
  }

  try {
    const parsed = JSON.parse(row.value) as {
      pointsMap?: Record<string, unknown>;
      syncedAt?: unknown;
    };
    const sourceMap = parsed?.pointsMap;
    const pointsMap: Record<string, number> = {};
    if (sourceMap && typeof sourceMap === 'object') {
      for (const [workflowId, value] of Object.entries(sourceMap)) {
        const n = Math.floor(Number(value));
        if (Number.isFinite(n) && n >= 0) {
          pointsMap[workflowId] = n;
        }
      }
    }
    const syncedAtRaw = Number(parsed?.syncedAt);
    const syncedAt = Number.isFinite(syncedAtRaw) && syncedAtRaw > 0 ? syncedAtRaw : null;
    return { pointsMap, syncedAt };
  } catch {
    return { pointsMap: {}, syncedAt: null };
  }
}

function normalizeCurrentLimit(limit: number, cfg: QueueRuntimeConfig['concurrency']) {
  return Math.min(cfg.maxLimit, Math.max(cfg.minLimit, Math.floor(limit)));
}

async function getQueueConcurrencyRuntimeState(cfg: QueueRuntimeConfig) {
  const fallback: QueueConcurrencyRuntimeState = {
    currentLimit: normalizeCurrentLimit(cfg.concurrency.baseLimit, cfg.concurrency),
    lastScaledAt: Date.now(),
    lastSignal: 'init',
    updatedAt: Date.now(),
  };

  const row = await prisma.systemSetting.findUnique({ where: { key: CONCURRENCY_STATE_KEY } });
  if (!row) return fallback;

  try {
    const parsed = JSON.parse(row.value) as Partial<QueueConcurrencyRuntimeState>;
    return {
      currentLimit: normalizeCurrentLimit(Number(parsed?.currentLimit || fallback.currentLimit), cfg.concurrency),
      lastScaledAt: toPositiveInt(parsed?.lastScaledAt, fallback.lastScaledAt),
      lastSignal: parsed?.lastSignal === 'throttle' || parsed?.lastSignal === 'success_batch' ? parsed.lastSignal : 'init',
      updatedAt: toPositiveInt(parsed?.updatedAt, fallback.updatedAt),
    };
  } catch {
    return fallback;
  }
}

async function setQueueConcurrencyRuntimeState(state: QueueConcurrencyRuntimeState) {
  await prisma.systemSetting.upsert({
    where: { key: CONCURRENCY_STATE_KEY },
    create: { key: CONCURRENCY_STATE_KEY, value: JSON.stringify(state) },
    update: { value: JSON.stringify(state) },
  });
}

export async function getEffectiveGlobalConcurrencyLimit() {
  const cfg = await getQueueRuntimeConfig();
  if (!cfg.concurrency.enabled) {
    return normalizeCurrentLimit(cfg.concurrency.baseLimit, cfg.concurrency);
  }

  const state = await getQueueConcurrencyRuntimeState(cfg);
  return normalizeCurrentLimit(state.currentLimit, cfg.concurrency);
}

export async function reportQueueConcurrencySignal(signal: 'throttle' | 'success_batch') {
  const cfg = await getQueueRuntimeConfig();
  if (!cfg.concurrency.enabled) {
    return {
      currentLimit: normalizeCurrentLimit(cfg.concurrency.baseLimit, cfg.concurrency),
      changed: false,
    };
  }

  const state = await getQueueConcurrencyRuntimeState(cfg);
  const now = Date.now();
  let nextLimit = state.currentLimit;

  if (signal === 'throttle') {
    nextLimit = normalizeCurrentLimit(state.currentLimit - cfg.concurrency.scaleDownStep, cfg.concurrency);
  } else {
    const canScaleUp = now - state.lastScaledAt >= cfg.concurrency.scaleUpCoolDownMs;
    if (canScaleUp) {
      nextLimit = normalizeCurrentLimit(state.currentLimit + cfg.concurrency.scaleUpStep, cfg.concurrency);
    }
  }

  const changed = nextLimit !== state.currentLimit;
  const nextState: QueueConcurrencyRuntimeState = {
    currentLimit: nextLimit,
    lastScaledAt: changed ? now : state.lastScaledAt,
    lastSignal: signal,
    updatedAt: now,
  };

  await setQueueConcurrencyRuntimeState(nextState);
  return {
    currentLimit: nextState.currentLimit,
    changed,
  };
}

export async function getQueueConcurrencyRuntimeSnapshot() {
  const cfg = await getQueueRuntimeConfig();
  const state = await getQueueConcurrencyRuntimeState(cfg);
  return {
    effectiveLimit: cfg.concurrency.enabled
      ? normalizeCurrentLimit(state.currentLimit, cfg.concurrency)
      : normalizeCurrentLimit(cfg.concurrency.baseLimit, cfg.concurrency),
    currentLimit: normalizeCurrentLimit(state.currentLimit, cfg.concurrency),
    lastScaledAt: state.lastScaledAt,
    lastSignal: state.lastSignal,
    enabled: cfg.concurrency.enabled,
  };
}
