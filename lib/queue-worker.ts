import { prisma } from '@/lib/prisma';
import { finalizeTaskPoints } from '@/lib/points';
import {
  cancelRunningHubTask as cancelRunningHubTaskUpstream,
  getRunningHubApiKey,
  queryTaskOutputs,
  reportUnknownRunningHubStatus,
} from '@/lib/runninghub';
import {
  getEffectiveGlobalConcurrencyLimit,
  getQueueRuntimeConfig,
  reportQueueConcurrencySignal,
} from '@/lib/queue-config';
import { acquireLock, refreshLock, releaseLock } from '@/lib/redis-lock';
import { applyTaskFailureRiskControl, clearTaskFailureStreak } from '@/lib/risk-control';
import { getWorkflowById } from '@/lib/workflows';

const LOCK_KEY = 'queue_worker_lock';
const POLL_INTERVAL_MS = 2000;
const INTERNAL_HEADER = 'x-internal-worker-secret';

function getWorkerSecret() {
  return process.env.INTERNAL_WORKER_SECRET || process.env.JWT_SECRET || 'dev-worker-secret';
}

function inferMediaType(url?: string | null) {
  const value = String(url || '').toLowerCase();
  if (/\.(jpg|jpeg|png|webp|bmp|gif|avif)/.test(value)) return 'image';
  if (/\.(mp4|webm|mov|mkv|avi)/.test(value)) return 'video';
  if (/\.(mp3|wav|aac|m4a|ogg|flac)/.test(value)) return 'audio';
  return 'unknown';
}

function isTimeoutMessage(value: unknown) {
  const text = String(value || '').toLowerCase();
  if (!text) return false;
  return (
    text.includes('timeout') ||
    text.includes('time out') ||
    text.includes('timed out') ||
    text.includes('超时') ||
    text.includes('执行过久')
  );
}

function extractResultUrl(data: unknown) {
  const payload = (data || {}) as {
    output?: {
      items?: Array<{ fileUrl?: string }>;
      images?: string[];
      url?: string;
    };
    image?: string;
    raw?: {
      data?: Array<{ fileUrl?: string }>;
      output?: { images?: string[]; url?: string };
    };
  };

  const url =
    payload.output?.items?.[0]?.fileUrl ||
    payload.output?.images?.[0] ||
    payload.output?.url ||
    payload.image ||
    payload.raw?.data?.[0]?.fileUrl ||
    payload.raw?.output?.images?.[0] ||
    payload.raw?.output?.url ||
    '';

  return String(url || '').trim();
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function markFailed(taskId: string, message: string) {
  await prisma.taskRecord.updateMany({
    where: { id: taskId, status: { not: 'cancelled' }, hiddenAt: null },
    data: {
      status: 'failed',
      error: message,
      finishedAt: new Date(),
    },
  });
}

/**
 * 调用 RunningHub 取消接口，终止正在执行的任务
 * 只影响该具体任务，不影响其他用户或其他任务
 */
async function cancelRunningHubTask(rhTaskId: string): Promise<void> {
  const apiKey = getRunningHubApiKey();
  if (!apiKey || !rhTaskId) return;
  try {
    await cancelRunningHubTaskUpstream(apiKey, rhTaskId);
  } catch {
    // 取消失败不阻断主流程，仅忽略
  }
}

async function getRunningHubTaskState(rhTaskId: string): Promise<'success' | 'failed' | 'running' | 'unknown'> {
  const apiKey = getRunningHubApiKey();
  if (!apiKey || !rhTaskId) return 'unknown';

  try {
    const { parsed } = await queryTaskOutputs(apiKey, rhTaskId);
    const data = parsed.json as { code?: number } | null;
    const code = Number(data?.code);

    if (code === 0) {
      const url = extractResultUrl(data);
      return url ? 'success' : 'failed';
    }
    if (code === 805) return 'failed';
    if (code === 804 || code === 813) return 'running';
    await reportUnknownRunningHubStatus({
      path: 'lib/queue-worker:getRunningHubTaskState',
      taskId: rhTaskId,
      code,
      message: 'queue worker unknown task status code',
    });
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

function extractRunningHubCostYuan(payload: unknown): number | null {
  const keys = new Set([
    'cost',
    'fee',
    'totalfee',
    'total_fee',
    'consumeamount',
    'consume_amount',
    'billingamount',
    'billing_amount',
    'amount',
    'price',
    'money',
  ]);

  const walk = (value: unknown, depth: number, allowLiteral = false): number | null => {
    if (depth > 6 || value == null) return null;

    if (allowLiteral && typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return value;
    }

    if (allowLiteral && typeof value === 'string') {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) return n;
      return null;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        const nested = walk(item, depth + 1, allowLiteral);
        if (nested != null) return nested;
      }
      return null;
    }

    if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const normalizedKey = String(k || '').toLowerCase();
        if (keys.has(normalizedKey)) {
          const n = walk(v, depth + 1, true);
          if (n != null) {
            if (normalizedKey.includes('fen')) return n / 100;
            return n;
          }
        }
      }

      for (const v of Object.values(value as Record<string, unknown>)) {
        const nested = walk(v, depth + 1, allowLiteral);
        if (nested != null) return nested;
      }
    }

    return null;
  };

  const raw = walk(payload, 0);
  if (raw == null) return null;

  if (raw > 10000) {
    return raw / 100;
  }
  return raw;
}

async function getRunningHubTaskCostYuan(rhTaskId: string): Promise<number | null> {
  const apiKey = getRunningHubApiKey();
  if (!apiKey || !rhTaskId) return null;

  try {
    const { res, parsed } = await queryTaskOutputs(apiKey, rhTaskId);
    if (!res.ok) return null;
    const data = parsed.json;
    const cost = extractRunningHubCostYuan(data);
    if (cost == null || !Number.isFinite(cost) || cost <= 0) return null;
    return cost;
  } catch {
    return null;
  }
}

async function computeCostBasedSettlement(task: {
  workflowId: string;
  pointsCost: number;
  taskId: string | null;
  startedAt: Date | null;
}) {
  const pointsCost = Math.max(0, Number(task.pointsCost || 0));
  if (pointsCost <= 0) {
    return {
      refundPoints: 0,
      chargedPoints: 0,
      estimatedCostYuan: 0,
      costSource: 'none' as const,
    };
  }

  const cfg = await getQueueRuntimeConfig();
  const pricing = cfg.pricing;

  let estimatedCostYuan = 0;
  let costSource: 'runninghub' | 'runtime_estimate' | 'none' = 'none';

  const elapsedMs = task.startedAt ? Math.max(0, Date.now() - task.startedAt.getTime()) : null;

  if (task.taskId) {
    const upstreamCost = await getRunningHubTaskCostYuan(task.taskId);
    if (upstreamCost && upstreamCost > 0) {
      estimatedCostYuan = upstreamCost;
      costSource = 'runninghub';
    }
  }

  if (estimatedCostYuan <= 0 && elapsedMs != null) {
    estimatedCostYuan = (elapsedMs / (60 * 60 * 1000)) * Math.max(0.0001, Number(pricing.runningCostYuanPerHour || 6));
    costSource = 'runtime_estimate';
  }

  const safeFactor = Math.max(1, Number(pricing.cancelRunningSafetyFactor || 1));
  const costPoints = Math.ceil(Math.max(0, estimatedCostYuan) * 100 * safeFactor);
  const multiplier = Math.max(0, Number(pricing.cancelRunningChargeMultiplier || 0));
  const minCharge = Math.max(0, Math.floor(Number(pricing.cancelRunningMinChargePoints || 0)));
  const chargedPointsRaw = Math.max(minCharge, Math.ceil(costPoints * multiplier));
  const chargedPoints = Math.min(pointsCost, Math.max(0, chargedPointsRaw));
  const refundPoints = Math.max(0, pointsCost - chargedPoints);

  return {
    refundPoints,
    chargedPoints,
    estimatedCostYuan,
    costSource,
  };
}

/**
 * 判断提交失败的错误信息是否属于"应用下架/不可用"类错误
 */
function isAppUnavailableError(errorMsg: string): boolean {
  const msg = String(errorMsg || '').toLowerCase();
  return (
    msg.includes('webapp not found') ||
    msg.includes('app not found') ||
    msg.includes('not exist') ||
    msg.includes('已下架') ||
    msg.includes('不存在') ||
    msg.includes('已停用') ||
    msg.includes('unavailable') ||
    msg.includes('disabled')
  );
}

function isConcurrencyLimitedError(errorMsg: string, upstreamStatus?: number): boolean {
  if (upstreamStatus === 429) return true;
  const msg = String(errorMsg || '').toLowerCase();
  return (
    msg.includes('429') ||
    msg.includes('rate limit') ||
    msg.includes('too many requests') ||
    msg.includes('并发') ||
    msg.includes('频率') ||
    msg.includes('限流')
  );
}

/**
 * 全局禁用某个 workflow（AI应用），写入 SystemSetting
 * 后续该应用的调用请求会被 run/route.ts 拦截
 */
async function disableWorkflowGlobally(workflowId: string, reason: string): Promise<void> {
  const key = `workflow_disabled_${workflowId}`;
  await prisma.systemSetting.upsert({
    where: { key },
    create: { key, value: JSON.stringify({ disabled: true, reason, disabledAt: new Date().toISOString() }) },
    update: { value: JSON.stringify({ disabled: true, reason, disabledAt: new Date().toISOString() }) },
  }).catch(() => undefined);
}

/**
 * 取消所有用户队列中指定 workflowId 的排队任务，并退还积分
 * 用于应用下架后清理全局队列，不影响该用户其他应用的任务
 */
async function cancelWorkflowQueuedTasksGlobally(workflowId: string, reason: string): Promise<void> {
  const queuedTasks = await prisma.taskRecord.findMany({
    where: {
      workflowId,
      status: { in: ['queueing', 'submitting'] },
      hiddenAt: null,
    },
  });

  if (queuedTasks.length === 0) return;

  await prisma.taskRecord.updateMany({
    where: {
      workflowId,
      status: { in: ['queueing', 'submitting'] },
      hiddenAt: null,
    },
    data: {
      status: 'cancelled',
      error: `AI应用已下架，任务自动取消：${reason}`,
      finishedAt: new Date(),
    },
  });

  for (const task of queuedTasks) {
    await finalizeTaskPoints({
      taskId: task.id,
      mode: 'release',
      reason: `应用下架释放预占积分：${task.workflowTitle}`,
      expectedPointsCost: Number(task.pointsCost || 0),
    }).catch(() => undefined);
  }
}

type FailureCause = 'submit_failed' | 'task_failed' | 'task_timeout' | 'payload_invalid';

/**
 * 按任务释放预占积分（幂等）
 */
async function releaseTaskReservedPoints(task: { id: string; workflowTitle: string; pointsCost?: number }, cause: FailureCause) {
  const cfg = await getQueueRuntimeConfig();
  const policyMap: Record<FailureCause, 'none' | 'full'> = {
    submit_failed: cfg.refundPolicy.submitFailed,
    task_failed: cfg.refundPolicy.taskFailed,
    task_timeout: cfg.refundPolicy.taskTimeout,
    payload_invalid: cfg.refundPolicy.payloadInvalid,
  };

  if (policyMap[cause] !== 'full') return;
  await finalizeTaskPoints({
    taskId: task.id,
    mode: 'release',
    reason: `任务失败释放预占积分：${task.workflowTitle}（${cause}）`,
    expectedPointsCost: Number.isFinite(Number(task.pointsCost)) ? Number(task.pointsCost) : undefined,
  });
}

async function verifyResultUrlReachable(url: string, timeoutMs: number) {
  if (!url) return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    const headRes = await fetch(url, {
      method: 'HEAD',
      cache: 'no-store',
      signal: controller.signal,
    });
    if (headRes.ok) return true;
  } catch {
    // ignore and fallback to GET probe
  } finally {
    clearTimeout(timer);
  }

  const controller2 = new AbortController();
  const timer2 = setTimeout(() => controller2.abort(), Math.max(1, timeoutMs));
  try {
    const getRes = await fetch(url, {
      method: 'GET',
      cache: 'no-store',
      headers: { Range: 'bytes=0-0' },
      signal: controller2.signal,
    });
    return getRes.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer2);
  }
}

async function markDeliveryRetryState(taskId: string, nextAttempt: number, maxAttempts: number, reason: string, retryIntervalMs: number) {
  if (nextAttempt >= maxAttempts) {
    await prisma.taskRecord.update({
      where: { id: taskId },
      data: {
        deliveryStatus: 'failed',
        deliveryAttempts: nextAttempt,
        deliveryLastError: reason,
        deliveryNextRetryAt: null,
      },
    });
    return;
  }

  await prisma.taskRecord.update({
    where: { id: taskId },
    data: {
      deliveryStatus: 'retrying',
      deliveryAttempts: nextAttempt,
      deliveryLastError: reason,
      deliveryNextRetryAt: new Date(Date.now() + retryIntervalMs),
    },
  });
}

async function claimNextDeliveryTask() {
  const now = new Date();
  const next = await prisma.taskRecord.findFirst({
    where: {
      status: 'success',
      hiddenAt: null,
      deliveryAckAt: null,
      deliveryStatus: { in: ['pending', 'retrying', 'failed'] },
      OR: [{ deliveryNextRetryAt: null }, { deliveryNextRetryAt: { lte: now } }],
    },
    orderBy: [{ deliveryNextRetryAt: 'asc' }, { updatedAt: 'asc' }],
  });

  if (!next) return null;
  if (next.deliveryAttempts >= next.deliveryMaxAttempts) {
    await prisma.taskRecord.update({
      where: { id: next.id },
      data: {
        deliveryStatus: 'failed',
        deliveryLastError: next.deliveryLastError || '结果投递重试次数已耗尽',
        deliveryNextRetryAt: null,
      },
    }).catch(() => undefined);
    return null;
  }

  const claimed = await prisma.taskRecord.updateMany({
    where: {
      id: next.id,
      status: 'success',
      hiddenAt: null,
      deliveryAckAt: null,
      deliveryStatus: { in: ['pending', 'retrying', 'failed'] },
    },
    data: { deliveryStatus: 'retrying' },
  });

  if (claimed.count === 0) return null;
  return next;
}

async function processDeliveryRetryTask(task: { id: string; taskId: string | null; deliveryAttempts: number; deliveryMaxAttempts: number }) {
  const queueCfg = await getQueueRuntimeConfig();
  const maxAttempts = Math.max(1, Number(task.deliveryMaxAttempts || queueCfg.delivery.maxAttempts));
  const attempt = task.deliveryAttempts + 1;
  const origin = process.env.INTERNAL_BASE_URL || 'http://127.0.0.1:3000';

  if (!task.taskId) {
    await markDeliveryRetryState(task.id, attempt, maxAttempts, '缺少上游任务ID，无法重投递结果', queueCfg.delivery.retryIntervalMs);
    return;
  }

  const statusRes = await fetch(`${origin}/api/task-status?taskId=${encodeURIComponent(task.taskId)}`, {
    cache: 'no-store',
  });
  const statusData = await statusRes.json().catch(() => ({}));
  if (!statusRes.ok) {
    await markDeliveryRetryState(
      task.id,
      attempt,
      maxAttempts,
      String(statusData?.error || `投递重试状态查询失败（${statusRes.status}）`),
      queueCfg.delivery.retryIntervalMs
    );
    return;
  }

  const upstreamStatus = String(statusData?.status || '').toLowerCase();
  if (!['success', 'completed', 'done'].includes(upstreamStatus)) {
    await markDeliveryRetryState(
      task.id,
      attempt,
      maxAttempts,
      `上游任务状态未完成：${upstreamStatus || 'unknown'}`,
      queueCfg.delivery.retryIntervalMs
    );
    return;
  }

  const url = extractResultUrl(statusData);
  if (!url) {
    await markDeliveryRetryState(task.id, attempt, maxAttempts, '上游成功但未返回结果链接', queueCfg.delivery.retryIntervalMs);
    return;
  }

  const reachable = await verifyResultUrlReachable(url, queueCfg.delivery.verifyTimeoutMs);
  if (!reachable) {
    await markDeliveryRetryState(task.id, attempt, maxAttempts, '结果链接不可达，等待重试', queueCfg.delivery.retryIntervalMs);
    return;
  }

  await prisma.taskRecord.update({
    where: { id: task.id },
    data: {
      resultUrl: url,
      resultType: inferMediaType(url),
      deliveryStatus: 'pending',
      deliveryAttempts: attempt,
      deliveryLastError: null,
      deliveryNextRetryAt: new Date(Date.now() + queueCfg.delivery.retryIntervalMs),
    },
  });
}

async function reconcileReservedTaskPoints() {
  const rows = await prisma.taskRecord.findMany({
    where: {
      pointState: 'reserved',
      status: { in: ['success', 'failed', 'timeout', 'cancelled'] },
    },
    orderBy: { updatedAt: 'asc' },
    take: 80,
    select: {
      id: true,
      status: true,
      workflowTitle: true,
    },
  });

  if (rows.length === 0) return;

  await Promise.all(
    rows.map(async (row) => {
      if (row.status === 'success') {
        await finalizeTaskPoints({
          taskId: row.id,
          mode: 'capture',
        }).catch(() => undefined);
        return;
      }

      await finalizeTaskPoints({
        taskId: row.id,
        mode: 'release',
        reason: `任务终态补偿释放：${row.workflowTitle}`,
      }).catch(() => undefined);
    })
  );
}

async function processSingleTask(task: {
  id: string;
  userId: string;
  requestId: string;
  workflowId: string;
  workflowTitle: string;
  pointsCost: number;
  payloadJson: string | null;
  startedAt?: Date | null;
}): Promise<{ throttleDetected: boolean }> {
  // ── 1. 参数校验 ──────────────────────────────────────────
  const payload = task.payloadJson ? JSON.parse(task.payloadJson) : null;
  const userMeta = await prisma.user.findUnique({
    where: { id: task.userId },
    select: { account: true },
  });
  const account = userMeta?.account;
  if (!payload || !payload.workflowId || !payload.inputs) {
    // 参数错误：只取消当前任务 + 退款，不影响用户其他任务
    await markFailed(task.id, '任务参数缺失，请重新提交');
    await releaseTaskReservedPoints(task, 'payload_invalid');
    await applyTaskFailureRiskControl({
      userId: task.userId,
      account,
      reason: 'payload_invalid',
      workflowId: task.workflowId,
    }).catch(() => undefined);
    return { throttleDetected: false };
  }

  const origin = process.env.INTERNAL_BASE_URL || 'http://127.0.0.1:3000';

  // ── 2. 提交任务到 RunningHub ──────────────────────────────
  const runRes = await fetch(`${origin}/api/run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [INTERNAL_HEADER]: getWorkerSecret(),
    },
    body: JSON.stringify({
      userId: task.userId,
      workflowId: payload.workflowId,
      inputs: payload.inputs,
      requestId: task.requestId,
    }),
  });
  const runData = await runRes.json().catch(() => ({}));

  if (!runRes.ok || !runData?.task_id) {
    const reason = String(runData?.error || '提交任务失败');
    await markFailed(task.id, reason);
    await releaseTaskReservedPoints(task, 'submit_failed');
    await applyTaskFailureRiskControl({
      userId: task.userId,
      account,
      reason: 'submit_failed',
      workflowId: task.workflowId,
    }).catch(() => undefined);

    // 如果是应用下架/不可用错误 → 全局禁用该应用 + 清理所有人队列中该应用的任务
    if (isAppUnavailableError(reason)) {
      await disableWorkflowGlobally(task.workflowId, reason);
      await cancelWorkflowQueuedTasksGlobally(task.workflowId, reason);
    }
    // 其他提交失败（网络/参数等）：只取消当前任务，不影响用户其他任务
    return {
      throttleDetected: isConcurrencyLimitedError(reason, Number(runData?.upstreamStatus || 0)),
    };
  }

  const upstreamTaskId = String(runData.task_id);
  const moveToRunning = await prisma.taskRecord.updateMany({
    where: { id: task.id, status: 'submitting', hiddenAt: null },
    data: { status: 'running', taskId: upstreamTaskId },
  });
  if (moveToRunning.count === 0) {
    await cancelRunningHubTask(upstreamTaskId);
    return { throttleDetected: false };
  }

  // ── 3. 轮询任务状态 ───────────────────────────────────────
  const queueCfg = await getQueueRuntimeConfig();
  const workflowProfile = queueCfg.pricing.workflowProfiles?.[task.workflowId];
  const workflow = getWorkflowById(task.workflowId);
  const baseRuntimeSec = Math.max(
    0,
    Number(workflowProfile?.runtimeSeconds ?? workflow?.runtimeSeconds ?? 0)
  );
  const mediaType = String(workflow?.mediaType || 'image').toLowerCase();
  const factor = mediaType === 'video' ? 1.5 : mediaType === 'audio' ? 1.35 : 1.25;
  const extraSeconds = mediaType === 'video' ? 20 : mediaType === 'audio' ? 15 : 10;
  const estimatedSeconds = Math.max(1, Math.ceil(baseRuntimeSec * factor + extraSeconds));
  const hardTimeoutMs = Math.ceil(estimatedSeconds * 1.3 * 1000);
  const startedAtMs = task.startedAt instanceof Date ? task.startedAt.getTime() : Date.now();
  let lastAliveAt = Date.now();
  let warnedHeartbeat = false;

  while (true) {
    await sleep(POLL_INTERVAL_MS);

    const latest = await prisma.taskRecord.findUnique({
      where: { id: task.id },
      select: { status: true },
    });
    if (!latest || latest.status === 'cancelled') {
      await cancelRunningHubTask(upstreamTaskId);
      return { throttleDetected: false };
    }

    if (Date.now() - startedAtMs > hardTimeoutMs) {
      const timeoutMsg = `任务超时：执行时长超过预计阈值（>${Math.ceil(hardTimeoutMs / 1000)}s）`;
      await cancelRunningHubTask(upstreamTaskId);
      await markFailed(task.id, timeoutMsg);
      await releaseTaskReservedPoints(task, 'task_timeout');
      await applyTaskFailureRiskControl({
        userId: task.userId,
        account,
        reason: 'task_timeout',
        workflowId: task.workflowId,
      }).catch(() => undefined);
      return { throttleDetected: false };
    }

    const statusRes = await fetch(
      `${origin}/api/task-status?taskId=${encodeURIComponent(upstreamTaskId)}`,
      { cache: 'no-store' }
    );
    const statusData = await statusRes.json().catch(() => ({}));

    if (!statusRes.ok) {
      if (Date.now() - lastAliveAt > queueCfg.heartbeatToleranceMs) {
        if (!warnedHeartbeat) {
          warnedHeartbeat = true;
          await prisma.taskRecord.update({
            where: { id: task.id },
            data: {
              error: `告警：状态心跳异常，连续 ${(queueCfg.heartbeatToleranceMs / 60000).toFixed(1)} 分钟未收到有效状态，继续等待中`,
            },
          }).catch(() => undefined);
        }
      }
      continue;
    }

    lastAliveAt = Date.now();
    warnedHeartbeat = false;

    if (statusData.status === 'running') {
      continue;
    }

    // ── 成功 ─────────────────────────────────────────────────
    if (statusData.status === 'success') {
      const url = extractResultUrl(statusData);
      const hasUrl = Boolean(url);
      const marked = await prisma.taskRecord.updateMany({
        where: { id: task.id, status: 'running', hiddenAt: null },
        data: {
          status: 'success',
          resultUrl: url || null,
          resultType: inferMediaType(url),
          error: null,
          finishedAt: new Date(),
          deliveryStatus: hasUrl ? 'pending' : 'retrying',
          deliveryAttempts: hasUrl ? 0 : 1,
          deliveryMaxAttempts: queueCfg.delivery.maxAttempts,
          deliveryLastError: hasUrl ? null : '上游成功但未返回结果链接，已进入结果投递重试',
          deliveryNextRetryAt: new Date(Date.now() + queueCfg.delivery.retryIntervalMs),
          deliveryAckAt: null,
        },
      });
      if (marked.count === 0) {
        return { throttleDetected: false };
      }
      await finalizeTaskPoints({
        taskId: task.id,
        mode: 'capture',
        expectedPointsCost: task.pointsCost,
      }).catch(() => undefined);
      await clearTaskFailureStreak(task.userId).catch(() => undefined);
      return { throttleDetected: false };
    }

    // ── 由 RunningHub 明确判定超时 ────────────────────────────
    if (statusData.status === 'timeout' || isTimeoutMessage(statusData.error) || isTimeoutMessage(statusData.message)) {
      const timeoutMsg = String(statusData.error || statusData.message || '任务超时');
      await markFailed(task.id, timeoutMsg.includes('超时') ? timeoutMsg : `任务超时：${timeoutMsg}`);
      await releaseTaskReservedPoints(task, 'task_timeout');
      await applyTaskFailureRiskControl({
        userId: task.userId,
        account,
        reason: 'task_timeout',
        workflowId: task.workflowId,
      }).catch(() => undefined);
      return { throttleDetected: false };
    }

    // ── 任务失败 ──────────────────────────────────────────────
    if (statusData.status === 'failed') {
      const failedMsg = String(statusData.error || '任务失败');
      // 尝试取消 RunningHub 侧任务（可能还在处理中）
      await cancelRunningHubTask(upstreamTaskId);
      await markFailed(task.id, failedMsg);
      await releaseTaskReservedPoints(task, 'task_failed');
      await applyTaskFailureRiskControl({
        userId: task.userId,
        account,
        reason: 'task_failed',
        workflowId: task.workflowId,
      }).catch(() => undefined);
      return { throttleDetected: false };
    }
  }
}

export async function triggerServerQueueWorker() {
  const owner = `worker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const locked = await acquireLock(LOCK_KEY, owner);
  if (!locked) return;

  let lockReleased = false;

  const safeRelease = async () => {
    if (!lockReleased) {
      lockReleased = true;
      await releaseLock(LOCK_KEY, owner);
    }
  };

  try {
    await refreshLock(LOCK_KEY, owner);

    // ── 0. 先做积分结算补偿（幂等），避免历史中断导致预占未收敛 ───────
    await reconcileReservedTaskPoints();

    // ── 1. 处理 delivery 重试（不占并发槽位）──────────────────────
    const nextDelivery = await claimNextDeliveryTask();
    if (nextDelivery) {
      try {
        await processDeliveryRetryTask({
          id: nextDelivery.id,
          taskId: nextDelivery.taskId,
          deliveryAttempts: nextDelivery.deliveryAttempts,
          deliveryMaxAttempts: nextDelivery.deliveryMaxAttempts,
        });
      } catch (error: unknown) {
        const queueCfg = await getQueueRuntimeConfig();
        const message = error instanceof Error ? error.message : '结果投递重试异常';
        await markDeliveryRetryState(
          nextDelivery.id,
          nextDelivery.deliveryAttempts + 1,
          Math.max(1, nextDelivery.deliveryMaxAttempts || queueCfg.delivery.maxAttempts),
          message,
          queueCfg.delivery.retryIntervalMs
        ).catch(() => undefined);
      }
    }

    // ── 2. 统计当前全局 running 数量 ──────────────────────────────
    const globalRunningCount = await prisma.taskRecord.count({
      where: { status: { in: ['running', 'submitting'] }, hiddenAt: null },
    });

    const globalConcurrencyLimit = await getEffectiveGlobalConcurrencyLimit();

    const availableSlots = globalConcurrencyLimit - globalRunningCount;
    if (availableSlots <= 0) return;

    // ── 3. 找出当前已有 running/submitting 任务的用户（每用户限1个）──
    const busyUserRecords = await prisma.taskRecord.findMany({
      where: { status: { in: ['running', 'submitting'] }, hiddenAt: null },
      select: { userId: true },
    });
    const busyUserIds = new Set(busyUserRecords.map((r) => r.userId));

    // ── 4. 找出有排队任务且当前空闲的用户，每人取最早一个 ────────────
    const candidates = await prisma.taskRecord.findMany({
      where: {
        status: 'queueing',
        hiddenAt: null,
        userId: busyUserIds.size > 0 ? { notIn: [...busyUserIds] } : undefined,
      },
      orderBy: { createdAt: 'asc' },
      take: availableSlots * 3,
    });

    const seenUsers = new Set<string>();
    const toDispatch: typeof candidates = [];
    for (const record of candidates) {
      if (seenUsers.has(record.userId)) continue;
      seenUsers.add(record.userId);
      toDispatch.push(record);
      if (toDispatch.length >= availableSlots) break;
    }

    if (toDispatch.length === 0) return;

    // ── 5. 释放锁后并发执行任务（任务耗时长，不应持锁阻塞其他 worker）
    await safeRelease();

    const results = await Promise.all(
      toDispatch.map(async (next) => {
        const claimed = await prisma.taskRecord.updateMany({
          where: { id: next.id, status: 'queueing', hiddenAt: null },
          data: { status: 'submitting', startedAt: new Date() },
        });
        if (claimed.count === 0) return;

        try {
          const outcome = await processSingleTask({
            id: next.id,
            userId: next.userId,
            requestId: next.requestId,
            workflowId: next.workflowId,
            workflowTitle: next.workflowTitle,
            pointsCost: next.pointsCost,
            payloadJson: next.payloadJson,
            startedAt: next.startedAt,
          });
          return outcome;
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : '任务执行异常';
          await markFailed(next.id, message);
          await releaseTaskReservedPoints(
            { id: next.id, workflowTitle: next.workflowTitle, pointsCost: next.pointsCost },
            'task_failed'
          ).catch(() => undefined);
          return { throttleDetected: false };
        } finally {
          // 任务完成后重新触发 worker，处理该用户的下一个排队任务
          void triggerServerQueueWorker();
        }
      })
    );

    const throttleDetected = results.some((item) => Boolean(item?.throttleDetected));
    if (throttleDetected) {
      await reportQueueConcurrencySignal('throttle').catch(() => undefined);
    } else if (toDispatch.length > 0) {
      await reportQueueConcurrencySignal('success_batch').catch(() => undefined);
    }
  } finally {
    await safeRelease();
  }
}

export async function cancelQueuedTaskById(userId: string, taskRecordId: string) {
  const record = await prisma.taskRecord.findFirst({
    where: { id: taskRecordId, userId },
  });
  if (!record) {
    throw new Error('任务不存在');
  }
  if (!['queueing', 'submitting', 'running'].includes(record.status)) {
    throw new Error('仅排队中或执行中的任务支持取消');
  }

  if (record.status === 'running' && record.taskId) {
    const upstreamState = await getRunningHubTaskState(record.taskId);
    if (upstreamState === 'success') {
      throw new Error('任务已完成生成，无法取消');
    }

    // 二次确认：先请求上游取消，再短暂等待并复查状态，降低竞态误取消风险
    await cancelRunningHubTask(record.taskId).catch(() => undefined);
    await sleep(800);
    const confirmState = await getRunningHubTaskState(record.taskId);
    if (confirmState === 'success') {
      throw new Error('任务已完成生成，无法取消');
    }
  }

  const updated = await prisma.taskRecord.updateMany({
    where: { id: taskRecordId, userId, status: { in: ['queueing', 'submitting', 'running'] } },
    data: {
      status: 'cancelled',
      error: '任务已取消（服务端队列）',
      finishedAt: new Date(),
    },
  });

  if (updated.count === 0) {
    throw new Error('任务取消失败，请稍后重试');
  }

  if (record.taskId && record.status !== 'running') {
    await cancelRunningHubTask(record.taskId).catch(() => undefined);
  }

  let refundPoints = Math.max(0, Number(record.pointsCost || 0));
  let chargedPoints = 0;
  let settleReason = `排队取消释放预占：${record.workflowTitle}`;

  if (record.status === 'running') {
    const settle = await computeCostBasedSettlement({
      workflowId: record.workflowId,
      pointsCost: record.pointsCost,
      taskId: record.taskId,
      startedAt: record.startedAt,
    });
    refundPoints = settle.refundPoints;
    chargedPoints = settle.chargedPoints;
    settleReason = `运行中取消释放预占：${record.workflowTitle}`;
  }

  const settleResult = await finalizeTaskPoints({
    taskId: record.id,
    mode: 'release',
    reason: settleReason,
    releasePoints: refundPoints,
    expectedPointsCost: record.pointsCost,
  }).catch(() => undefined);

  return {
    record,
    refunded: Boolean(settleResult?.changed),
    pointsDelta: Boolean(settleResult?.changed)
      ? Math.max(0, Number((settleResult as { releasedPoints?: number } | undefined)?.releasedPoints ?? refundPoints))
      : 0,
    chargedPoints,
  };
}
