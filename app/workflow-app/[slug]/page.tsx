'use client';
/* eslint-disable @next/next/no-img-element */

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { useParams } from 'next/navigation';
import { ArrowLeft, Download } from 'lucide-react';
import { Toaster, toast } from 'sonner';
import { getWorkflowBySlug, getWorkflowPointCost } from '@/lib/workflows';
import { HISTORY_KEY, QUEUE_PAUSE_REASON_KEY, WORKFLOW_CENTER_LOCK_KEY } from '@/app/page';

const DISMISSED_RESULT_MAP_KEY = 'dundun-dismissed-result-map-v1';

type MediaType = 'image' | 'video' | 'audio' | 'unknown';

type ResultMedia = {
  url: string;
  type: MediaType;
};

type HistorySnapshot = {
  id: string;
  requestId: string;
  workflowId: string;
  workflowTitle: string;
  taskId: string | null;
  pointsCost: number;
  status: 'submitting' | 'queueing' | 'running' | 'success' | 'failed' | 'timeout' | 'cancelled';
  resultUrl: string | null;
  resultType: MediaType;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  deliveryStatus?: 'none' | 'pending' | 'retrying' | 'delivered' | 'failed';
  retryPayload?: unknown;
};

function inferMediaType(url?: string | null): MediaType {
  const lowerUrl = String(url || '').toLowerCase().split('?')[0];
  if (/(\.jpg|\.jpeg|\.png|\.webp|\.bmp|\.gif|\.avif)$/.test(lowerUrl)) return 'image';
  if (/(\.mp4|\.webm|\.mov|\.mkv|\.avi)$/.test(lowerUrl)) return 'video';
  if (/(\.mp3|\.wav|\.aac|\.m4a|\.ogg|\.flac)$/.test(lowerUrl)) return 'audio';
  return 'unknown';
}

function createRequestId() {
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

const REQUEST_ID_REUSE_WINDOW_MS = 25_000;

function stableSerialize(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableSerialize(item)).join(',')}]`;

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableSerialize(obj[key])}`).join(',')}}`;
}

function buildBatchRetryKey(params: { workflowId: string; inputs: Record<string, unknown>; generateTimes: number; pointsCost: number }) {
  return [
    params.workflowId,
    String(params.generateTimes),
    String(params.pointsCost),
    stableSerialize(params.inputs),
  ].join('|');
}

async function syncUserState(history: unknown[]) {
  try {
    await fetch('/api/me/tasks', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tasks: history }),
    });
  } catch {
    // ignore sync failures
  }
}

function renderMediaPreview(
  media: ResultMedia,
  hooks?: {
    onLoad?: () => void;
    onError?: () => void;
  }
) {
  if (media.type === 'image') {
    return (
      <img
        src={media.url}
        alt="结果图"
        className="w-full rounded-2xl object-cover"
        onLoad={hooks?.onLoad}
        onError={hooks?.onError}
      />
    );
  }
  if (media.type === 'video') {
    return <video src={media.url} controls className="w-full rounded-2xl bg-black" onLoadedData={hooks?.onLoad} onError={hooks?.onError} />;
  }
  if (media.type === 'audio') {
    return (
      <div className="rounded-2xl border border-zinc-200 bg-white p-4">
        <audio src={media.url} controls className="w-full" onLoadedData={hooks?.onLoad} onError={hooks?.onError} />
      </div>
    );
  }
  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-4 text-sm text-zinc-500 break-all">
      暂不支持内嵌预览，请直接下载：{media.url}
    </div>
  );
}

export default function WorkflowDetailPage() {
  const params = useParams<{ slug: string }>();
  const slug = String(params?.slug || '');

  const workflow = useMemo(() => getWorkflowBySlug(slug), [slug]);
  const workflowPointCost = useMemo(() => getWorkflowPointCost(workflow), [workflow]);

  const [formData, setFormData] = useState<Record<string, unknown>>({});
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [statusText, setStatusText] = useState('');
  const [resultMedia, setResultMedia] = useState<ResultMedia | null>(null);
  const [dismissedResultCreatedAt, setDismissedResultCreatedAt] = useState<number>(0);
  const [showResultAfterTs, setShowResultAfterTs] = useState<number>(0);
  const [resultTaskRecordId, setResultTaskRecordId] = useState<string>('');
  const [balance, setBalance] = useState(5);
  const [queueCount, setQueueCount] = useState(0);
  const [pageSkeleton, setPageSkeleton] = useState(true);
  const [generateTimes, setGenerateTimes] = useState(1);
  const [isLoading, setIsLoading] = useState(false);
  const [workflowCenterLocked, setWorkflowCenterLocked] = useState(false);
  const [queuePaused, setQueuePaused] = useState(false);
  const enqueueRetryRequestIdsRef = useRef<Map<string, { requestIds: string[]; expiresAt: number }>>(new Map());

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch('/api/me', { cache: 'no-store' });
        const data = await response.json().catch(() => null);
        if (!cancelled && response.ok && data?.success) {
          setBalance(Number(data.data?.points ?? 0));
          if (typeof window !== 'undefined') {
            window.localStorage.setItem('dundun-balance-v1', String(Number(data.data?.points ?? 0)));
          }
        }
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const syncHistoryFromServer = async () => {
      try {
        const response = await fetch('/api/me/tasks?page=1&pageSize=200', { cache: 'no-store' });
        const data = await response.json().catch(() => null);
        if (cancelled || !response.ok || !data?.success) return;

        const records = Array.isArray(data.data?.records) ? data.data.records : [];
        const mapped = records.map((row: unknown) => {
          const item = row as {
            id?: unknown;
            requestId?: unknown;
            workflowId?: unknown;
            workflowTitle?: unknown;
            taskId?: unknown;
            pointsCost?: unknown;
            status?: unknown;
            resultUrl?: unknown;
            resultType?: unknown;
            error?: unknown;
            createdAt?: unknown;
            updatedAt?: unknown;
            payloadJson?: unknown;
            deliveryStatus?: unknown;
          };

          let retryPayload: unknown = undefined;
          if (item.payloadJson) {
            try {
              retryPayload = JSON.parse(String(item.payloadJson));
            } catch {
              retryPayload = undefined;
            }
          }

          return {
            id: String(item.id || ''),
            requestId: String(item.requestId || ''),
            workflowId: String(item.workflowId || ''),
            workflowTitle: String(item.workflowTitle || ''),
            taskId: item.taskId ? String(item.taskId) : null,
            pointsCost: Number(item.pointsCost || 0),
            status: String(item.status || 'queueing') as HistorySnapshot['status'],
            resultUrl: item.resultUrl ? String(item.resultUrl) : null,
            resultType: (item.resultType ? String(item.resultType) : 'unknown') as HistorySnapshot['resultType'],
            error: item.error ? String(item.error) : null,
            createdAt: new Date(String(item.createdAt ?? Date.now())).getTime(),
            updatedAt: new Date(String(item.updatedAt ?? Date.now())).getTime(),
            deliveryStatus: (item.deliveryStatus ? String(item.deliveryStatus) : 'none') as HistorySnapshot['deliveryStatus'],
            retryPayload,
          } satisfies HistorySnapshot;
        });

        if (typeof window !== 'undefined') {
          window.localStorage.setItem(
            HISTORY_KEY,
            JSON.stringify(mapped.sort((a: HistorySnapshot, b: HistorySnapshot) => b.createdAt - a.createdAt).slice(0, 100))
          );
        }
      } catch {
        // ignore
      }
    };

    void syncHistoryFromServer();
    const timer = window.setInterval(() => {
      void syncHistoryFromServer();
    }, 2500);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const rawDismissed = window.localStorage.getItem(DISMISSED_RESULT_MAP_KEY);
    if (rawDismissed && workflow?.workflowId) {
      try {
        const parsed = JSON.parse(rawDismissed) as Record<string, number>;
        const value = parsed?.[workflow.workflowId];
        if (typeof value === 'number' && Number.isFinite(value)) setDismissedResultCreatedAt(value);
      } catch {
        // ignore
      }
    }

    const syncLock = () => {
      setWorkflowCenterLocked(window.localStorage.getItem(WORKFLOW_CENTER_LOCK_KEY) === '1');
      setQueuePaused(!!window.localStorage.getItem(QUEUE_PAUSE_REASON_KEY));
    };
    syncLock();
    window.addEventListener('storage', syncLock);
    window.addEventListener('focus', syncLock);
    return () => {
      window.removeEventListener('storage', syncLock);
      window.removeEventListener('focus', syncLock);
    };
  }, [workflow?.workflowId]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!workflow?.workflowId) return;

    const raw = window.localStorage.getItem(DISMISSED_RESULT_MAP_KEY);
    let parsed: Record<string, number> = {};
    if (raw) {
      try {
        parsed = JSON.parse(raw) as Record<string, number>;
      } catch {
        parsed = {};
      }
    }

    if (dismissedResultCreatedAt > 0) {
      parsed[workflow.workflowId] = dismissedResultCreatedAt;
    } else {
      delete parsed[workflow.workflowId];
    }

    window.localStorage.setItem(DISMISSED_RESULT_MAP_KEY, JSON.stringify(parsed));
  }, [dismissedResultCreatedAt, workflow?.workflowId]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem('dundun-balance-v1', String(balance));
  }, [balance]);

  useEffect(() => {
    let cancelled = false;

    const syncQueueCount = async () => {
      try {
        const response = await fetch('/api/me/tasks?status=queueing&page=1&pageSize=200', { cache: 'no-store' });
        const data = await response.json().catch(() => null);
        if (!response.ok || !data?.success || cancelled) return;

        const queueingCount = Number(data.data?.total || 0);

        const runningRes = await fetch('/api/me/tasks?status=running&page=1&pageSize=200', { cache: 'no-store' });
        const runningData = await runningRes.json().catch(() => null);
        if (!runningRes.ok || !runningData?.success || cancelled) return;

        setQueueCount(queueingCount + Number(runningData.data?.total || 0));
      } catch {
        // ignore
      }
    };

    void syncQueueCount();
    const timer = window.setInterval(() => {
      void syncQueueCount();
    }, 1500);
    const onFocus = () => {
      void syncQueueCount();
    };
    window.addEventListener('focus', onFocus);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !workflow) return;

    const syncLatestResult = () => {
      const raw = window.localStorage.getItem(HISTORY_KEY);
      if (!raw) {
        setResultMedia(null);
        return;
      }

      try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return;

        const latest = (parsed as HistorySnapshot[])
          .filter((item) => item.workflowId === workflow.workflowId && item.status === 'success' && !!item.resultUrl)
          .sort((a, b) => b.createdAt - a.createdAt)[0];

        if (!latest?.resultUrl) {
          setResultMedia(null);
          setResultTaskRecordId('');
          return;
        }
        if (showResultAfterTs > 0 && latest.createdAt < showResultAfterTs) {
          setResultMedia(null);
          setResultTaskRecordId('');
          return;
        }
        if (dismissedResultCreatedAt > 0 && latest.createdAt <= dismissedResultCreatedAt) {
          setResultMedia(null);
          setResultTaskRecordId('');
          return;
        }
        setResultMedia({
          url: latest.resultUrl,
          type: latest.resultType || inferMediaType(latest.resultUrl),
        });
        setResultTaskRecordId(String(latest.id || ''));
      } catch {
        setResultMedia(null);
        setResultTaskRecordId('');
      }
    };

    syncLatestResult();
    const timer = window.setInterval(syncLatestResult, 1200);
    window.addEventListener('storage', syncLatestResult);
    window.addEventListener('focus', syncLatestResult);

    return () => {
      window.clearInterval(timer);
      window.removeEventListener('storage', syncLatestResult);
      window.removeEventListener('focus', syncLatestResult);
    };
  }, [workflow, dismissedResultCreatedAt, showResultAfterTs]);

  useEffect(() => {
    const timer = setTimeout(() => setPageSkeleton(false), 260);
    return () => clearTimeout(timer);
  }, [slug]);

  useEffect(() => {
    setShowResultAfterTs(Date.now());
    setResultMedia(null);
    setResultTaskRecordId('');
  }, [slug]);

  const handleInputChange = (key: string, value: unknown) => {
    setFormData((prev) => ({ ...prev, [key]: value }));
  };

  const handleAudioUpload = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) setAudioFile(file);
  };

  const fileToDataUrl = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

  const handleGenerate = async () => {
    if (!workflow) return;
    if (workflowCenterLocked) {
      toast.error('工作流中心已临时禁用，请等待问题修复后再使用');
      return;
    }
    if (queuePaused) {
      toast.error('任务队列已暂停，请先处理当前异常任务后再继续');
      return;
    }

    const missing = workflow.inputs.find((i) => i.type === 'text' && !formData[i.key]);
    if (missing) {
      toast.error(`请输入 ${missing.label}`);
      return;
    }

    const totalCost = workflowPointCost * generateTimes;
    if (balance < totalCost) {
      toast.error(`积分不足，当前 ${balance} 积分，本次需要 ${totalCost} 积分`);
      return;
    }

    try {
      setIsLoading(true);
      setDismissedResultCreatedAt(0);
      setShowResultAfterTs(Date.now());
      const inputs: Record<string, unknown> = {};
      for (const input of workflow.inputs) {
        if (input.type === 'audio') {
          if (audioFile) {
            const dataUrl = await fileToDataUrl(audioFile);
            inputs[input.key] = {
              __rh_file: true,
              fileName: audioFile.name,
              dataUrl,
            };
          }
        } else {
          inputs[input.key] = formData[input.key] ?? input.defaultValue;
        }
      }

      const payload = {
        workflowId: workflow.workflowId,
        workflowTitle: workflow.title,
        inputs: JSON.parse(JSON.stringify(inputs)),
        isAudioWorkflow: workflow.inputs.some((i) => i.type === 'audio'),
        pointsCost: workflowPointCost,
      };

      const retryKey = buildBatchRetryKey({
        workflowId: workflow.workflowId,
        inputs: payload.inputs,
        generateTimes,
        pointsCost: workflowPointCost,
      });
      const cachedRetry = enqueueRetryRequestIdsRef.current.get(retryKey);
      const canReuse =
        !!cachedRetry &&
        cachedRetry.requestIds.length === generateTimes &&
        cachedRetry.expiresAt > Date.now();
      const requestIds = canReuse
        ? cachedRetry.requestIds
        : Array.from({ length: generateTimes }, () => createRequestId());
      enqueueRetryRequestIdsRef.current.set(retryKey, {
        requestIds,
        expiresAt: Date.now() + REQUEST_ID_REUSE_WINDOW_MS,
      });

      const now = Date.now();
      const pendingHistory: HistorySnapshot[] = Array.from({ length: generateTimes }).map((_, i) => {
        const historyId = `${now}-${Math.random().toString(36).slice(2, 8)}-ext-history-${i}`;
        const requestId = requestIds[i];
        return {
          id: historyId,
          requestId,
          workflowId: workflow.workflowId,
          workflowTitle: workflow.title,
          taskId: null,
          pointsCost: workflowPointCost,
          status: 'queueing',
          resultUrl: null,
          resultType: 'unknown',
          error: null,
          createdAt: now + i,
          updatedAt: now + i,
          retryPayload: { ...payload, requestId },
        };
      });

      const newTasks = pendingHistory.map((item, i) => ({
        id: item.id,
        requestId: item.requestId,
        workflowId: workflow.workflowId,
        workflowTitle: workflow.title,
        pointsCost: workflowPointCost,
        payload: { ...payload, requestId: item.requestId },
        createdAt: now + i,
      }));

      const rawHistory = window.localStorage.getItem(HISTORY_KEY);
      const historyList = rawHistory ? JSON.parse(rawHistory) : [];
      const normalizedHistory = Array.isArray(historyList) ? historyList : [];
      const mergedHistory = [...pendingHistory, ...normalizedHistory].slice(0, 100);
      window.localStorage.setItem(HISTORY_KEY, JSON.stringify(mergedHistory));

      const consumeRes = await fetch('/api/points/consume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          points: totalCost,
          reason: `工作流入队：${workflow.title} ×${generateTimes}`,
          relatedId: workflow.workflowId,
        }),
      });
      const consumeData = await consumeRes.json().catch(() => ({}));
      if (!consumeRes.ok || !consumeData?.success) {
        toast.error(consumeData?.message || '扣费失败，请稍后重试');
        setIsLoading(false);
        return;
      }

      setBalance(Number(consumeData?.data?.points ?? Math.max(0, balance - totalCost)));

      const enqueueRes = await fetch('/api/tasks/enqueue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tasks: newTasks }),
      });
      const enqueueData = await enqueueRes.json().catch(() => ({}));
      if (!enqueueRes.ok || !enqueueData?.success) {
        await fetch('/api/points/refund', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            points: totalCost,
            reason: `入队失败返还：${workflow.title} ×${generateTimes}`,
            relatedId: workflow.workflowId,
          }),
        }).catch(() => undefined);

        const rollbackHistory = mergedHistory.map((item) =>
          pendingHistory.some((pending) => pending.id === item.id)
            ? {
                ...item,
                status: 'cancelled' as const,
                error: '任务入队失败，已自动返还积分',
                updatedAt: Date.now(),
              }
            : item
        );
        window.localStorage.setItem(HISTORY_KEY, JSON.stringify(rollbackHistory));
        toast.error(enqueueData?.message || '任务入队失败');
        setIsLoading(false);
        return;
      }

      enqueueRetryRequestIdsRef.current.delete(retryKey);

      await syncUserState(mergedHistory);

      toast.success(`已入队 ${generateTimes} 次，已扣除 ${totalCost} 积分`);
      setStatusText('已入队，任务在后台执行中...');
      setTimeout(() => setStatusText(''), 2600);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : '入队失败';
      toast.error(message);
    } finally {
      setIsLoading(false);
    }
  };

  if (!workflow) {
    return (
      <div className="min-h-screen bg-[#f4f6fb] p-8">
        <div className="max-w-3xl mx-auto bg-white border border-zinc-200 rounded-2xl p-8 text-center">
          <h1 className="text-2xl font-bold text-zinc-900 mb-2">工作流不存在</h1>
          <p className="text-zinc-500 mb-4">请检查链接是否正确。</p>
          <Link href="/" className="inline-flex px-4 py-2 rounded-xl btn-brand-gradient">
            返回工作流中心
          </Link>
        </div>
      </div>
    );
  }

  if (pageSkeleton) {
    return (
      <div className="min-h-screen bg-[#f4f6fb]">
        <Toaster position="top-center" richColors />

        <div className="bg-white border-b border-zinc-200 px-6 md:px-8 py-3">
          <div className="max-w-7xl mx-auto flex items-center justify-between gap-4 animate-pulse">
            <div className="h-4 w-72 rounded bg-zinc-200" />
            <div className="h-8 w-24 rounded-full bg-zinc-200" />
          </div>
        </div>

        <div className="max-w-7xl mx-auto p-6 md:p-8 animate-pulse">
          <div className="h-5 w-44 rounded bg-zinc-200 mb-6" />

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            {/* 参数区骨架 */}
            <div className="bg-white border border-zinc-200 rounded-2xl p-6">
              <div className="h-7 w-56 rounded bg-zinc-200 mb-2" />
              <div className="h-4 w-80 rounded bg-zinc-200 mb-6" />

              <div className="space-y-5">
                <div>
                  <div className="h-4 w-24 rounded bg-zinc-200 mb-2" />
                  <div className="h-28 rounded-xl bg-zinc-100 border border-zinc-200" />
                </div>
                <div>
                  <div className="h-4 w-24 rounded bg-zinc-200 mb-2" />
                  <div className="h-12 rounded-xl bg-zinc-100 border border-zinc-200" />
                </div>
              </div>

              <div className="mt-6 h-12 rounded-xl bg-zinc-200" />
            </div>

            {/* 结果区骨架 */}
            <div className="bg-white border border-zinc-200 rounded-2xl p-6">
              <div className="h-6 w-28 rounded bg-zinc-200 mb-4" />
              <div className="rounded-2xl border border-zinc-200 bg-zinc-100 h-[360px]" />
              <div className="mt-4 h-10 w-32 rounded-xl bg-zinc-200" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#f4f6fb]">
      <Toaster position="top-center" richColors />

      <div className="bg-white border-b border-zinc-200 px-6 md:px-8 py-3">
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-4">
          <div className="text-sm text-zinc-600">📢 通知：工作流持续升级中，生成结果请以实际为准</div>
          <div className="flex items-center gap-3">
            <div className="text-sm text-zinc-700 bg-zinc-100 rounded-full px-3 py-1">💰 {balance}</div>
            <div className="text-sm text-zinc-700 bg-zinc-100 rounded-full px-3 py-1">🧾 队列 {queueCount}</div>
            {isLoading && (
              <div className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-3 py-1">
                ⏳ 任务进行中
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto p-6 md:p-8">
        <div className="flex items-center justify-between mb-6">
          <Link href="/" className="inline-flex items-center gap-2 text-zinc-700 hover:text-zinc-900">
            <ArrowLeft className="w-4 h-4" />
            返回工作流中心
          </Link>
          <div className="text-sm text-zinc-500">{workflow.enTitle || 'Workflow'}</div>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          {/* 左侧：参数输入 + 开始生成 */}
          <div className="bg-white border border-zinc-200 rounded-2xl p-6">
            <h1 className="text-2xl font-bold text-zinc-900 mb-1">{workflow.title}</h1>
            <p className="text-zinc-500 mb-5">{workflow.description}</p>

            <div className="space-y-5">
              {workflow.inputs.map((input) => (
                <div key={input.key}>
                  <label className="block text-sm text-zinc-500 mb-2">{input.label}</label>

                  {input.type === 'text' && (
                    <textarea
                      value={String(formData[input.key] ?? '')}
                      onChange={(e) => handleInputChange(input.key, e.target.value)}
                      placeholder={input.placeholder}
                      className="w-full h-28 bg-white border border-zinc-200 rounded-xl p-3 text-zinc-900 placeholder-zinc-400"
                    />
                  )}

                  {input.type === 'number' && (
                    <input
                      type="number"
                      value={Number(formData[input.key] ?? input.defaultValue ?? 0)}
                      onChange={(e) => handleInputChange(input.key, parseFloat(e.target.value) || 0)}
                      min={input.min}
                      max={input.max}
                      step={input.step}
                      className="w-full bg-white border border-zinc-200 rounded-xl p-3 text-zinc-900"
                    />
                  )}

                  {input.type === 'audio' && (
                    <div className="border-2 border-dashed border-zinc-300 rounded-xl p-6 text-center">
                      <input
                        type="file"
                        accept="audio/*"
                        onChange={handleAudioUpload}
                        className="hidden"
                        id={`audio-${input.key}`}
                      />
                      <label htmlFor={`audio-${input.key}`} className="cursor-pointer block text-zinc-600">
                        点击上传参考音频
                        {audioFile && <p className="mt-2 text-sm text-zinc-500">{audioFile.name}</p>}
                      </label>
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div className="mt-5 rounded-xl border border-zinc-200 bg-zinc-50 p-4">
              <label className="block text-sm text-zinc-600 mb-2">生成次数</label>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setGenerateTimes((n) => Math.max(1, n - 1))}
                  className="w-9 h-9 rounded-lg border border-zinc-300 bg-white"
                >
                  -
                </button>
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={generateTimes}
                  onChange={(e) => setGenerateTimes(Math.max(1, Math.min(10, Number(e.target.value) || 1)))}
                  className="w-20 text-center bg-white border border-zinc-200 rounded-lg p-2 text-zinc-900"
                />
                <button
                  onClick={() => setGenerateTimes((n) => Math.min(10, n + 1))}
                  className="w-9 h-9 rounded-lg border border-zinc-300 bg-white"
                >
                  +
                </button>
              </div>
              <div className="text-xs text-zinc-500 mt-2">相同参数连续入队，最多 10 次</div>
              <div className="text-xs text-zinc-500 mt-1">单次扣费：{workflowPointCost} 积分，本次预计：{workflowPointCost * generateTimes} 积分</div>
              <div className="text-xs text-zinc-500 mt-1">预计时长：{workflow.time || '约30s'}（仅供参考）</div>
            </div>

            <button
              onClick={handleGenerate}
              disabled={workflowCenterLocked || queuePaused || isLoading}
              className="mt-6 w-full py-3 rounded-xl btn-brand-gradient disabled:opacity-60 disabled:cursor-not-allowed"
            >
              立即生成
            </button>

            {workflowCenterLocked ? (
              <div className="mt-3 text-sm text-rose-600">当前已临时禁用全部 AI 应用，请等待修复后再继续生成。</div>
            ) : null}
            {!workflowCenterLocked && queuePaused ? (
              <div className="mt-3 text-sm text-rose-600">任务队列已暂停，请先处理当前异常任务后再继续生成。</div>
            ) : null}

            {statusText && <div className="mt-3 text-sm text-zinc-500">{statusText}</div>}
          </div>

          {/* 右侧：生成结果预览 + 下载 */}
          <div className="bg-white border border-zinc-200 rounded-2xl p-6">
            <h2 className="text-lg font-semibold text-zinc-900 mb-4">生成结果</h2>

            {resultMedia ? (
              <>
                {renderMediaPreview(resultMedia, {
                  onLoad: () => {
                    if (!resultTaskRecordId) return;
                    void fetch('/api/tasks/delivery', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ taskRecordId: resultTaskRecordId, action: 'ack' }),
                    }).catch(() => undefined);
                  },
                  onError: () => {
                    if (!resultTaskRecordId) return;
                    void fetch('/api/tasks/delivery', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        taskRecordId: resultTaskRecordId,
                        action: 'fail',
                        reason: '工作流详情页结果渲染失败',
                      }),
                    }).catch(() => undefined);
                  },
                })}
                <div className="mt-4 flex items-center justify-between gap-3">
                  <a
                    href={resultMedia.url}
                    download
                    className="inline-flex h-10 min-w-[110px] items-center justify-center gap-2 px-4 rounded-xl btn-brand-gradient"
                  >
                    <Download className="w-4 h-4" />
                    下载
                  </a>
                  <button
                    onClick={() => {
                      const raw = window.localStorage.getItem(HISTORY_KEY);
                      if (raw) {
                        try {
                          const parsed = JSON.parse(raw);
                          if (Array.isArray(parsed)) {
                            const latest = (parsed as HistorySnapshot[])
                              .filter((item) => item.workflowId === workflow.workflowId && item.status === 'success' && !!item.resultUrl)
                              .sort((a, b) => b.createdAt - a.createdAt)[0];
                            if (typeof latest?.createdAt === 'number') setDismissedResultCreatedAt(latest.createdAt);
                          }
                        } catch {
                          // ignore
                        }
                      }
                      setResultMedia(null);
                    }}
                    className="inline-flex h-10 min-w-[110px] items-center justify-center gap-2 px-4 rounded-xl btn-brand-gradient"
                  >
                    确认
                  </button>
                </div>
              </>
            ) : (
              <div className="rounded-2xl border border-dashed border-zinc-300 bg-zinc-50 p-10 text-center text-zinc-500">
                暂无结果，请先在左侧填写参数并开始生成。
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
