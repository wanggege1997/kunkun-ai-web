import { prisma } from '@/lib/prisma';
import { getWorkflowById, getWorkflowDefaultMaxWaitMsById, getWorkflowMediaTypeById } from '@/lib/workflows';

export type RefundPolicy = 'none' | 'full';

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
};

const CONFIG_KEY = 'queue_runtime_config_v1';

function toPositiveInt(value: unknown, fallback: number) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

export async function getQueueRuntimeConfig(): Promise<QueueRuntimeConfig> {
  const row = await prisma.systemSetting.findUnique({ where: { key: CONFIG_KEY } });
  if (!row) return DEFAULT_CONFIG;

  try {
    const parsed = JSON.parse(row.value) as Partial<QueueRuntimeConfig>;
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

export async function getTaskTimeoutMs(workflowId: string) {
  const cfg = await getQueueRuntimeConfig();
  const override = cfg.workflowTimeoutOverrides[workflowId];
  if (override && override > 0) return override;

  const workflow = getWorkflowById(workflowId);
  if (workflow?.maxWaitMs) return workflow.maxWaitMs;

  const mediaType = getWorkflowMediaTypeById(workflowId);
  if (mediaType === 'audio') return cfg.timeoutDefaults.audioMs;
  if (mediaType === 'video') return cfg.timeoutDefaults.videoMs;
  return cfg.timeoutDefaults.imageMs || getWorkflowDefaultMaxWaitMsById(workflowId);
}
