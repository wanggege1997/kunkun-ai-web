# Queue Scheduler Pseudocode (Next.js + Prisma)

## Goals

- Per user serial execution: one active task per user.
- Global concurrent cap: stay below RunningHub limit (100), reserve safety buffer.
- Idempotent point lifecycle: reserve -> capture/release.
- One worker flow handles dispatch, status transition, compensation, delivery retry.

## Suggested Runtime Knobs

```ts
const RUNNINGHUB_MAX = 100
const SAFETY_BUFFER = 20
const GLOBAL_LIMIT = 80 // RUNNINGHUB_MAX - SAFETY_BUFFER
const CLAIM_BATCH_MULTIPLIER = 3
```

## Worker Main Loop (Pseudocode)

```ts
async function workerTick() {
  await withDistributedLock('queue_worker_lock', async () => {
    // 0) compensate point state first (idempotent)
    await reconcileReservedPoints()

    // 1) process one delivery retry task (does not consume RunningHub slot)
    const deliveryTask = await claimNextDeliveryTask()
    if (deliveryTask) await processDeliveryRetryTask(deliveryTask)

    // 2) compute available global slots
    const runningCount = await prisma.taskRecord.count({
      where: { status: { in: ['running', 'submitting'] }, hiddenAt: null },
    })
    const slots = Math.max(0, GLOBAL_LIMIT - runningCount)
    if (slots <= 0) return

    // 3) exclude busy users (per-user serial)
    const busy = await prisma.taskRecord.findMany({
      where: { status: { in: ['running', 'submitting'] }, hiddenAt: null },
      select: { userId: true },
    })
    const busyUserIds = new Set(busy.map((x) => x.userId))

    // 4) pull queue candidates then take one per user
    const candidates = await prisma.taskRecord.findMany({
      where: {
        status: 'queueing',
        hiddenAt: null,
        userId: busyUserIds.size > 0 ? { notIn: [...busyUserIds] } : undefined,
      },
      orderBy: { createdAt: 'asc' },
      take: slots * CLAIM_BATCH_MULTIPLIER,
    })
    const dispatchList = pickEarliestOnePerUser(candidates, slots)
    if (dispatchList.length === 0) return

    // 5) release lock, run tasks concurrently
  })

  await Promise.all(dispatchList.map(processQueuedTask))
}
```

## Per Task Processing (Pseudocode)

```ts
async function processQueuedTask(task) {
  const claimed = await prisma.taskRecord.updateMany({
    where: { id: task.id, status: 'queueing', hiddenAt: null },
    data: { status: 'submitting', startedAt: new Date() },
  })
  if (claimed.count === 0) return

  try {
    const run = await submitToRunningHub(task)
    if (!run.ok) {
      await failTask(task.id, run.error)
      await releaseReservedPoints(task.id)
      return
    }

    await prisma.taskRecord.update({
      where: { id: task.id },
      data: { status: 'running', taskId: run.taskId },
    })

    const result = await pollRunningHubUntilTerminal(run.taskId, task.workflowId)

    if (result.status === 'success') {
      await prisma.taskRecord.update({
        where: { id: task.id },
        data: {
          status: 'success',
          resultUrl: result.url,
          finishedAt: new Date(),
          deliveryStatus: result.url ? 'pending' : 'retrying',
        },
      })
      await captureReservedPoints(task.id)
      return
    }

    await failTask(task.id, result.error)
    await releaseReservedPoints(task.id)
  } catch (e) {
    await failTask(task.id, stringifyError(e))
    await releaseReservedPoints(task.id)
  } finally {
    void triggerServerQueueWorker() // schedule next user task
  }
}
```

## Idempotent Point Lifecycle

### Reserve in Enqueue Transaction

```ts
await prisma.$transaction(async (tx) => {
  const existing = await tx.taskRecord.findUnique({
    where: { userId_requestId: { userId, requestId } },
    select: { id: true },
  })
  if (existing) return { duplicated: true }

  // reserve points first
  if (pointsCost > 0) {
    const u = await tx.user.findUnique({ where: { id: userId }, select: { points: true } })
    if (!u || u.points < pointsCost) throw new Error('积分不足')
    const next = u.points - pointsCost
    await tx.user.update({ where: { id: userId }, data: { points: next } })
    await tx.pointLog.create({
      data: {
        userId,
        delta: -pointsCost,
        reason: `任务积分预占：${workflowTitle}`,
        relatedId: taskId,
        balanceAfter: next,
      },
    })
  }

  await tx.taskRecord.create({
    data: {
      id: taskId,
      userId,
      requestId,
      status: 'queueing',
      pointsCost,
      pointState: pointsCost > 0 ? 'reserved' : 'none',
      pointReservedAt: pointsCost > 0 ? new Date() : null,
    },
  })
})
```

### Capture / Release (Idempotent Rule)

- Capture only when `pointState = reserved` and terminal status is success.
- Release only when `pointState = reserved` and terminal status is failed/timeout/cancelled.
- If state already `captured` or `released`, no-op.

## Compensation Query (Prisma)

```ts
const rows = await prisma.taskRecord.findMany({
  where: {
    pointState: 'reserved',
    status: { in: ['success', 'failed', 'timeout', 'cancelled'] },
  },
  orderBy: { updatedAt: 'asc' },
  take: 80,
})
```

## Core Prisma Query Conditions

### Count running slots

```ts
where: { status: { in: ['running', 'submitting'] }, hiddenAt: null }
```

### Busy users set

```ts
where: { status: { in: ['running', 'submitting'] }, hiddenAt: null }
select: { userId: true }
```

### Queue candidates (FIFO)

```ts
where: {
  status: 'queueing',
  hiddenAt: null,
  userId: busyUserIds.length ? { notIn: busyUserIds } : undefined,
}
orderBy: { createdAt: 'asc' }
```

### Claim exactly one queued task (CAS style)

```ts
await prisma.taskRecord.updateMany({
  where: { id: taskId, status: 'queueing', hiddenAt: null },
  data: { status: 'submitting', startedAt: new Date() },
})
```

### Delivery retry claim

```ts
where: {
  status: 'success',
  hiddenAt: null,
  deliveryAckAt: null,
  deliveryStatus: { in: ['pending', 'retrying', 'failed'] },
  OR: [{ deliveryNextRetryAt: null }, { deliveryNextRetryAt: { lte: new Date() } }],
}
orderBy: [{ deliveryNextRetryAt: 'asc' }, { updatedAt: 'asc' }]
```
