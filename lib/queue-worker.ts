import { prisma } from '@/lib/prisma';
import { changeUserPoints } from '@/lib/points';
import { getQueueRuntimeConfig, getTaskTimeoutMs, type RefundPolicy } from '@/lib/queue-config';

const LOCK_KEY = 'queue_worker_lock';
const LOCK_TTL_MS = 45_000;
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

async function acquireLock(owner: string) {
  const now = Date.now();
  const current = await prisma.systemSetting.findUnique({ where: { key: LOCK_KEY } });

  if (current) {
    try {
      const parsed = JSON.parse(current.value) as { owner: string; expiresAt: number };
      if (parsed.expiresAt > now && parsed.owner !== owner) return false;
    } catch {
      // ignore parse failure
    }
  }

  await prisma.systemSetting.upsert({
    where: { key: LOCK_KEY },
    create: {
      key: LOCK_KEY,
      value: JSON.stringify({ owner, expiresAt: now + LOCK_TTL_MS }),
    },
    update: {
      value: JSON.stringify({ owner, expiresAt: now + LOCK_TTL_MS }),
    },
  });

  return true;
}

async function refreshLock(owner: string) {
  await prisma.systemSetting.update({
    where: { key: LOCK_KEY },
    data: { value: JSON.stringify({ owner, expiresAt: Date.now() + LOCK_TTL_MS }) },
  }).catch(() => undefined);
}

async function releaseLock(owner: string) {
  const current = await prisma.systemSetting.findUnique({ where: { key: LOCK_KEY } });
  if (!current) return;
  try {
    const parsed = JSON.parse(current.value) as { owner: string };
    if (parsed.owner !== owner) return;
  } catch {
    return;
  }
  await prisma.systemSetting.delete({ where: { key: LOCK_KEY } }).catch(() => undefined);
}

async function markFailed(taskId: string, message: string) {
  await prisma.taskRecord.update({
    where: { id: taskId },
    data: {
      status: 'failed',
      error: message,
      finishedAt: new Date(),
    },
  });
}

async function pauseUserAndRefundQueuedTasks(userId: string, triggerTaskId: string, reason: string) {
  await prisma.user.update({
    where: { id: userId },
    data: { taskBlocked: true },
  }).catch(() => undefined);

  const queuedTasks = await prisma.taskRecord.findMany({
    where: {
      userId,
      id: { not: triggerTaskId },
      status: { in: ['queueing', 'submitting'] },
    },
    orderBy: { createdAt: 'asc' },
  });

  if (queuedTasks.length === 0) return;

  await prisma.$transaction([
    prisma.taskRecord.updateMany({
      where: {
        userId,
        id: { in: queuedTasks.map((task) => task.id) },
        status: { in: ['queueing', 'submitting'] },
      },
      data: {
        status: 'cancelled',
        error: `前置任务失败自动暂停：${reason}`,
        finishedAt: new Date(),
      },
    }),
  ]);

  for (const task of queuedTasks) {
    if (task.pointsCost > 0) {
      await changeUserPoints({
        userId,
        delta: task.pointsCost,
        reason: `自动返还：${task.workflowTitle}（前置任务失败后自动取消）`,
        relatedId: task.id,
      });
    }
  }
}

type FailureCause = 'submit_failed' | 'task_failed' | 'task_timeout' | 'payload_invalid';

async function maybeRefundTriggerTask(task: { userId: string; id: string; workflowTitle: string; pointsCost: number }, cause: FailureCause) {
  const cfg = await getQueueRuntimeConfig();
  const policyMap: Record<FailureCause, RefundPolicy> = {
    submit_failed: cfg.refundPolicy.submitFailed,
    task_failed: cfg.refundPolicy.taskFailed,
    task_timeout: cfg.refundPolicy.taskTimeout,
    payload_invalid: cfg.refundPolicy.payloadInvalid,
  };

  if (policyMap[cause] !== 'full') return;
  if (task.pointsCost <= 0) return;

  await changeUserPoints({
    userId: task.userId,
    delta: task.pointsCost,
    reason: `任务失败返还：${task.workflowTitle}（${cause}）`,
    relatedId: task.id,
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

async function processSingleTask(task: {
  id: string;
  userId: string;
  requestId: string;
  workflowId: string;
  workflowTitle: string;
  pointsCost: number;
  payloadJson: string | null;
}) {
  const payload = task.payloadJson ? JSON.parse(task.payloadJson) : null;
  if (!payload || !payload.workflowId || !payload.inputs) {
    await markFailed(task.id, '任务参数缺失，无法执行');
    await maybeRefundTriggerTask(task, 'payload_invalid');
    await pauseUserAndRefundQueuedTasks(task.userId, task.id, '任务参数缺失');
    return;
  }

  const origin = process.env.INTERNAL_BASE_URL || 'http://127.0.0.1:3000';
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
    await maybeRefundTriggerTask(task, 'submit_failed');
    await pauseUserAndRefundQueuedTasks(task.userId, task.id, reason);
    return;
  }

  const upstreamTaskId = String(runData.task_id);
  await prisma.taskRecord.update({
    where: { id: task.id },
    data: {
      status: 'running',
      taskId: upstreamTaskId,
    },
  });

  const maxWaitMs = await getTaskTimeoutMs(task.workflowId);
  const queueCfg = await getQueueRuntimeConfig();
  const startedAtMs = Date.now();
  let lastAliveAt = Date.now();
  let warnedHeartbeat = false;
  let softTimeoutNoted = false;

  while (true) {
    await sleep(POLL_INTERVAL_MS);

    const elapsed = Date.now() - startedAtMs;

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
      if (elapsed > maxWaitMs && !softTimeoutNoted) {
        softTimeoutNoted = true;
        await prisma.taskRecord.update({
          where: { id: task.id },
          data: {
            error: `告警：已超过预计等待 ${(maxWaitMs / 60000).toFixed(1)} 分钟，任务仍在上游执行，继续等待完成`,
          },
        }).catch(() => undefined);
      }
      continue;
    }

    if (elapsed > maxWaitMs && !softTimeoutNoted) {
      softTimeoutNoted = true;
      await prisma.taskRecord.update({
        where: { id: task.id },
        data: {
          error: `告警：已超过预计等待 ${(maxWaitMs / 60000).toFixed(1)} 分钟，继续检测任务最终状态`,
        },
      }).catch(() => undefined);
    }

    if (statusData.status === 'success') {
      const url = extractResultUrl(statusData);
      const hasUrl = Boolean(url);
      await prisma.taskRecord.update({
        where: { id: task.id },
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
          deliveryNextRetryAt: hasUrl
            ? new Date(Date.now() + queueCfg.delivery.retryIntervalMs)
            : new Date(Date.now() + queueCfg.delivery.retryIntervalMs),
          deliveryAckAt: null,
        },
      });
      return;
    }

    if (statusData.status === 'failed') {
      const failedMsg = String(statusData.error || '任务失败');
      await prisma.taskRecord.update({
        where: { id: task.id },
        data: {
          status: 'failed',
          error: failedMsg,
          finishedAt: new Date(),
        },
      });
      await maybeRefundTriggerTask(task, 'task_failed');
      await pauseUserAndRefundQueuedTasks(task.userId, task.id, failedMsg);
      return;
    }
  }
}

export async function triggerServerQueueWorker() {
  const owner = `worker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const locked = await acquireLock(owner);
  if (!locked) return;

  try {
    for (let i = 0; i < 80; i += 1) {
      await refreshLock(owner);

      let stepped = false;

      const next = await prisma.taskRecord.findFirst({
        where: { status: 'queueing', hiddenAt: null },
        orderBy: { createdAt: 'asc' },
      });
      if (next) {
        const claimed = await prisma.taskRecord.updateMany({
          where: { id: next.id, status: 'queueing', hiddenAt: null },
          data: { status: 'submitting', startedAt: new Date() },
        });
        if (claimed.count > 0) {
          stepped = true;
          try {
            await processSingleTask({
              id: next.id,
              userId: next.userId,
              requestId: next.requestId,
              workflowId: next.workflowId,
              workflowTitle: next.workflowTitle,
              pointsCost: next.pointsCost,
              payloadJson: next.payloadJson,
            });
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : '任务执行异常';
            await markFailed(next.id, message);
            await pauseUserAndRefundQueuedTasks(next.userId, next.id, message);
          }
        }
      }

      const nextDelivery = await claimNextDeliveryTask();
      if (nextDelivery) {
        stepped = true;
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

      if (!stepped) break;
    }
  } finally {
    await releaseLock(owner);
  }
}

export async function cancelQueuedTaskById(userId: string, taskRecordId: string) {
  const record = await prisma.taskRecord.findFirst({
    where: { id: taskRecordId, userId },
  });
  if (!record) {
    throw new Error('任务不存在');
  }
  if (!['queueing', 'submitting'].includes(record.status)) {
    throw new Error('仅排队中的任务支持取消');
  }

  const updated = await prisma.taskRecord.updateMany({
    where: { id: taskRecordId, userId, status: { in: ['queueing', 'submitting'] } },
    data: {
      status: 'cancelled',
      error: '任务已取消（服务端队列）',
      finishedAt: new Date(),
    },
  });

  if (updated.count === 0) {
    throw new Error('任务取消失败，请稍后重试');
  }

  if (record.pointsCost > 0) {
    await changeUserPoints({
      userId,
      delta: record.pointsCost,
      reason: `排队取消返还：${record.workflowTitle}`,
      relatedId: record.workflowId,
    });
  }

  return record;
}
