'use client';
/* eslint-disable @next/next/no-img-element */

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Download } from 'lucide-react';
import { Toaster, toast } from 'sonner';
import { getWorkflowBySlug, getWorkflowPointCost } from '@/lib/workflows';
import { useUserBalance, refreshUserBalance, setUserBalance, setUserAuthState } from '@/lib/user-balance-store';
import { HISTORY_KEY, QUEUE_PAUSE_REASON_KEY, WORKFLOW_CENTER_LOCK_KEY } from '@/app/page';

const DISMISSED_RESULT_MAP_KEY = 'dundun-dismissed-result-map-v1';

type MediaType = 'image' | 'video' | 'audio' | 'unknown';

type ResultMedia = {
  url: string;
  type: MediaType;
};

type UploadPreviewItem = {
  name: string;
  url: string;
  type: 'image' | 'video' | 'audio';
};

type UploadViewerState = {
  open: boolean;
  item: UploadPreviewItem | null;
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

type DisabledWorkflowStatus = {
  workflowId: string;
  disabled: boolean;
  reason?: string;
  disabledAt?: string;
};

function inferMediaType(url?: string | null): MediaType {
  const lowerUrl = String(url || '').toLowerCase().split('?')[0];
  if (/(\.jpg|\.jpeg|\.png|\.webp|\.bmp|\.gif|\.avif)$/.test(lowerUrl)) return 'image';
  if (/(\.mp4|\.webm|\.mov|\.mkv|\.avi)$/.test(lowerUrl)) return 'video';
  if (/(\.mp3|\.wav|\.aac|\.m4a|\.ogg|\.flac)$/.test(lowerUrl)) return 'audio';
  const raw = String(url || '').toLowerCase();
  if (/(image|img|png|jpg|jpeg|webp|gif|avif)/.test(raw)) return 'image';
  if (/(video|mp4|webm|mov|mkv|avi)/.test(raw)) return 'video';
  if (/(audio|mp3|wav|aac|m4a|ogg|flac)/.test(raw)) return 'audio';
  return 'unknown';
}

function resolveResultMediaType(resultType: unknown, resultUrl?: string | null): MediaType {
  const normalized = String(resultType || '').trim().toLowerCase();
  if (normalized === 'image' || normalized === 'video' || normalized === 'audio') {
    return normalized;
  }
  return inferMediaType(resultUrl);
}

function getMediaTypeLabel(type: MediaType): string {
  if (type === 'image') return '图片';
  if (type === 'video') return '视频';
  if (type === 'audio') return '音频';
  return '文件';
}

function getMediaPreviewHint(type: MediaType): string {
  if (type === 'image') return '支持直接预览高清图片，可下载原图';
  if (type === 'video') return '支持在线播放视频，可下载原文件';
  if (type === 'audio') return '支持在线试听音频，可下载原文件';
  return '当前文件类型不支持内嵌预览，可直接下载';
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
      <div className="rounded-2xl overflow-hidden border border-zinc-200 bg-zinc-50">
        <img
          src={media.url}
          alt="结果图"
          className="w-full max-h-[560px] object-contain"
          loading="eager"
          onLoad={hooks?.onLoad}
          onError={hooks?.onError}
        />
      </div>
    );
  }
  if (media.type === 'video') {
    return (
      <div className="rounded-2xl overflow-hidden border border-zinc-200 bg-black">
        <video
          src={media.url}
          controls
          playsInline
          preload="metadata"
          className="w-full max-h-[560px]"
          onLoadedData={hooks?.onLoad}
          onError={hooks?.onError}
        />
      </div>
    );
  }
  if (media.type === 'audio') {
    return (
      <div className="rounded-2xl border border-zinc-200 bg-white p-4 space-y-3">
        <div className="text-sm text-zinc-600">音频结果已生成，可在线播放或下载保存。</div>
        <audio src={media.url} controls preload="metadata" className="w-full" onLoadedData={hooks?.onLoad} onError={hooks?.onError} />
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
  const router = useRouter();
  const slug = String(params?.slug || '');

  const workflow = useMemo(() => getWorkflowBySlug(slug), [slug]);
  const workflowPointCost = useMemo(() => getWorkflowPointCost(workflow), [workflow]);
  const [prechargePointsMap, setPrechargePointsMap] = useState<Record<string, number>>({});
  const [runtimeSecondsMap, setRuntimeSecondsMap] = useState<Record<string, number>>({});
  const [pointsProfileReady, setPointsProfileReady] = useState(false);
  const [runtimeProfileReady, setRuntimeProfileReady] = useState(false);
  const [generateTimes, setGenerateTimes] = useState(1);
  const effectiveWorkflowPointCost = useMemo(() => {
    const workflowId = String(workflow?.workflowId || '');
    const synced = Number(prechargePointsMap[workflowId]);
    if (!Number.isNaN(synced) && synced >= 0) return synced;
    return workflowPointCost;
  }, [prechargePointsMap, workflow?.workflowId, workflowPointCost]);

  const pointsDisplayText = useMemo(() => {
    if (!pointsProfileReady) return '同步中...';
    return `${effectiveWorkflowPointCost} 积分`;
  }, [pointsProfileReady, effectiveWorkflowPointCost]);

  const totalPointsDisplayText = useMemo(() => {
    if (!pointsProfileReady) return '同步中...';
    return `${effectiveWorkflowPointCost * generateTimes} 积分`;
  }, [pointsProfileReady, effectiveWorkflowPointCost, generateTimes]);

  const estimatedRuntimeText = useMemo(() => {
    if (!runtimeProfileReady) {
      return '同步中...';
    }
    const workflowId = String(workflow?.workflowId || '');
    const baseSeconds = Number(runtimeSecondsMap[workflowId]);
    if (!Number.isFinite(baseSeconds) || baseSeconds <= 0) {
      return workflow?.time || '约30s';
    }

    const mediaType = String(workflow?.mediaType || '').toLowerCase();
    const factor = mediaType === 'video' ? 1.5 : mediaType === 'audio' ? 1.35 : 1.25;
    const extraSeconds = mediaType === 'video' ? 20 : mediaType === 'audio' ? 15 : 10;
    const adjustedSeconds = Math.ceil(baseSeconds * factor + extraSeconds);
    if (adjustedSeconds >= 60) {
      return `${Math.ceil(adjustedSeconds / 60)}m`;
    }
    return `${adjustedSeconds}s`;
  }, [runtimeProfileReady, runtimeSecondsMap, workflow]);

  const [formData, setFormData] = useState<Record<string, unknown>>({});
  const [fileInputs, setFileInputs] = useState<Record<string, File | null>>({});
  const [filePreviews, setFilePreviews] = useState<Record<string, UploadPreviewItem>>({});
  const [uploadViewer, setUploadViewer] = useState<UploadViewerState>({ open: false, item: null });
  const [statusText, setStatusText] = useState('');
  const [resultMedia, setResultMedia] = useState<ResultMedia | null>(null);
  const [dismissedResultCreatedAt, setDismissedResultCreatedAt] = useState<number>(0);
  const [showResultAfterTs, setShowResultAfterTs] = useState<number>(0);
  const [resultTaskRecordId, setResultTaskRecordId] = useState<string>('');
  const userBalance = useUserBalance();
  const balance = userBalance.balance;
  const authReady = userBalance.ready;
  const isAuthed = userBalance.isAuthed;
  const [queueCount, setQueueCount] = useState(0);
  const pageSkeleton = false;
  const [isLoading, setIsLoading] = useState(false);
  const [workflowCenterLocked, setWorkflowCenterLocked] = useState(false);
  const [queuePaused, setQueuePaused] = useState(false);
  const [disabledWorkflowMeta, setDisabledWorkflowMeta] = useState<DisabledWorkflowStatus | null>(null);
  const enqueueRetryRequestIdsRef = useRef<Map<string, { requestIds: string[]; expiresAt: number }>>(new Map());
  const submitInFlightRef = useRef(false);
  const viewerVideoRef = useRef<HTMLVideoElement | null>(null);

  const workflowDisabled = Boolean(disabledWorkflowMeta?.disabled);
  const workflowDisabledReason = String(disabledWorkflowMeta?.reason || '').trim();

  useEffect(() => {
    if (!authReady || isAuthed) return;
    const returnTo = slug ? `/workflow-app/${encodeURIComponent(slug)}` : '/';
    router.replace(`/?login=1&expired=1&returnTo=${encodeURIComponent(returnTo)}`);
  }, [authReady, isAuthed, router, slug]);

  useEffect(() => {
    if (authReady && !isAuthed) return;

    let cancelled = false;

    const syncBalance = async () => {
      if (cancelled) return;
      await refreshUserBalance();
    };

    void syncBalance();

    if (!isAuthed) {
      return () => {
        cancelled = true;
      };
    }

    let timer: ReturnType<typeof setInterval> | null = null;

    const onFocusOrVisible = () => {
      void syncBalance();
    };

    timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      void syncBalance();
    }, 10_000);

    window.addEventListener('focus', onFocusOrVisible);
    document.addEventListener('visibilitychange', onFocusOrVisible);

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      window.removeEventListener('focus', onFocusOrVisible);
      document.removeEventListener('visibilitychange', onFocusOrVisible);
    };
  }, [authReady, isAuthed]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch('/api/workflow-precharge-points', { cache: 'no-store' });
        const data = await response.json().catch(() => null);
        if (!cancelled && response.ok && data?.success) {
          const source = data.data?.pointsMap;
          if (source && typeof source === 'object') {
            const next: Record<string, number> = {};
            for (const [workflowId, value] of Object.entries(source as Record<string, unknown>)) {
              const n = Number(value);
              if (!Number.isNaN(n) && n >= 0) next[String(workflowId)] = Math.floor(n);
            }
            setPrechargePointsMap(next);
          }

          const runtimeSource = data.data?.runtimeSecondsMap;
          if (runtimeSource && typeof runtimeSource === 'object') {
            const nextRuntime: Record<string, number> = {};
            for (const [workflowId, value] of Object.entries(runtimeSource as Record<string, unknown>)) {
              const n = Number(value);
              if (!Number.isNaN(n) && n >= 0) nextRuntime[String(workflowId)] = Math.floor(n);
            }
            setRuntimeSecondsMap(nextRuntime);
          }
        }
      } catch {
        // ignore
      } finally {
        if (!cancelled) setPointsProfileReady(true);
        if (!cancelled) setRuntimeProfileReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!workflow?.workflowId) {
      setDisabledWorkflowMeta(null);
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const fetchDisabledStatus = async () => {
      try {
        const response = await fetch('/api/workflows/disabled', { cache: 'no-store' });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data?.success || !Array.isArray(data.data) || cancelled) return;
        const hit = (data.data as DisabledWorkflowStatus[]).find(
          (item) => String(item?.workflowId || '') === workflow.workflowId
        );
        setDisabledWorkflowMeta(hit ? {
          workflowId: workflow.workflowId,
          disabled: Boolean(hit.disabled),
          reason: String(hit.reason || ''),
          disabledAt: String(hit.disabledAt || ''),
        } : null);
      } catch {
        // ignore
      }
    };

    void fetchDisabledStatus();
    timer = setInterval(() => {
      void fetchDisabledStatus();
    }, 30_000);

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [workflow?.workflowId]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    let round = 0;

    // 先用本地历史秒显队列数，避免刚进页时短暂显示 0
    if (typeof window !== 'undefined') {
      try {
        const rawHistory = window.localStorage.getItem(HISTORY_KEY);
        if (rawHistory) {
          const parsed = JSON.parse(rawHistory) as Array<{ status?: string }>;
          if (Array.isArray(parsed)) {
            const cachedQueueCount = parsed.filter((item) => {
              const status = String(item?.status || '');
              return status === 'queueing' || status === 'submitting' || status === 'running';
            }).length;
            if (cachedQueueCount > 0) {
              setQueueCount(cachedQueueCount);
            }
          }
        }
      } catch {
        // ignore cache read errors
      }
    }

    if (!authReady) {
      return () => {
        cancelled = true;
      };
    }

    if (!isAuthed) {
      setQueueCount(0);
      return () => {
        cancelled = true;
      };
    }

    const syncHistoryFromServer = async () => {
      try {
        const response = await fetch('/api/me/tasks?page=1&pageSize=200', { cache: 'no-store' });
        const data = await response.json().catch(() => null);
        if (cancelled || !response.ok || !data?.success) return false;

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

        return mapped.some((item: HistorySnapshot) => ['queueing', 'submitting', 'running'].includes(item.status));
      } catch {
        return false;
      }
    };

    const nextDelay = (hasActiveTasks: boolean) => {
      const hidden = typeof document !== 'undefined' && document.visibilityState !== 'visible';
      if (hasActiveTasks) {
        if (round < 3) return 2000;
        if (round < 10) return hidden ? 4500 : 3000;
        return hidden ? 8000 : 5000;
      }
      return hidden ? 20000 : 12000;
    };

    const runLoop = async () => {
      const hasActiveTasks = await syncHistoryFromServer();
      if (cancelled) return;
      round += 1;
      timer = window.setTimeout(() => {
        void runLoop();
      }, nextDelay(hasActiveTasks));
    };

    const forceRefresh = () => {
      if (cancelled) return;
      round = 0;
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      void runLoop();
    };

    timer = window.setTimeout(() => {
      void runLoop();
    }, 1000);
    window.addEventListener('focus', forceRefresh);
    document.addEventListener('visibilitychange', forceRefresh);

    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      window.removeEventListener('focus', forceRefresh);
      document.removeEventListener('visibilitychange', forceRefresh);
    };
  }, [authReady, isAuthed]);

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
    let cancelled = false;
    let timer: number | null = null;
    let round = 0;

    if (!authReady) {
      return () => {
        cancelled = true;
      };
    }

    if (!isAuthed) {
      setQueueCount(0);
      return () => {
        cancelled = true;
      };
    }

    const syncQueueCount = async () => {
      try {
        // 并发请求 queueing 和 running，减少等待时间
        const [queueingRes, submittingRes, runningRes] = await Promise.all([
          fetch('/api/me/tasks?status=queueing&page=1&pageSize=1', { cache: 'no-store' }),
          fetch('/api/me/tasks?status=submitting&page=1&pageSize=1', { cache: 'no-store' }),
          fetch('/api/me/tasks?status=running&page=1&pageSize=1', { cache: 'no-store' }),
        ]);
        if (cancelled) return false;
        const [queueingData, submittingData, runningData] = await Promise.all([
          queueingRes.json().catch(() => null),
          submittingRes.json().catch(() => null),
          runningRes.json().catch(() => null),
        ]);
        if (cancelled) return false;
        const q = queueingRes.ok && queueingData?.success ? Number(queueingData.data?.total || 0) : 0;
        const s = submittingRes.ok && submittingData?.success ? Number(submittingData.data?.total || 0) : 0;
        const r = runningRes.ok && runningData?.success ? Number(runningData.data?.total || 0) : 0;
        setQueueCount(q + s + r);
        return q + s + r > 0;
      } catch {
        return false;
      }
    };

    const nextDelay = (hasQueue: boolean) => {
      const hidden = typeof document !== 'undefined' && document.visibilityState !== 'visible';
      if (hasQueue) {
        if (round < 4) return 1800;
        if (round < 12) return hidden ? 4500 : 3000;
        return hidden ? 9000 : 5500;
      }
      return hidden ? 20000 : 15000;
    };

    const runLoop = async () => {
      const hasQueue = await syncQueueCount();
      if (cancelled) return;
      round += 1;
      timer = window.setTimeout(() => {
        void runLoop();
      }, nextDelay(hasQueue));
    };

    const forceRefresh = () => {
      if (cancelled) return;
      round = 0;
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      void runLoop();
    };

    // 立即启动一次，减少“先显示0再跳变”
    void runLoop();
    window.addEventListener('focus', forceRefresh);
    document.addEventListener('visibilitychange', forceRefresh);

    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      window.removeEventListener('focus', forceRefresh);
      document.removeEventListener('visibilitychange', forceRefresh);
    };
  }, [authReady, isAuthed]);

  useEffect(() => {
    if (typeof window === 'undefined' || !workflow) return;
    let cancelled = false;
    let timer: number | null = null;
    let round = 0;

    const syncLatestResult = () => {
      const raw = window.localStorage.getItem(HISTORY_KEY);
      if (!raw) {
        setResultMedia(null);
        return false;
      }

      try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return false;

        const latest = (parsed as HistorySnapshot[])
          .filter((item) => item.workflowId === workflow.workflowId && item.status === 'success' && !!item.resultUrl)
          .sort((a, b) => b.createdAt - a.createdAt)[0];

        if (!latest?.resultUrl) {
          setResultMedia(null);
          setResultTaskRecordId('');
          return false;
        }
        if (showResultAfterTs > 0 && latest.createdAt < showResultAfterTs) {
          setResultMedia(null);
          setResultTaskRecordId('');
          return false;
        }
        if (dismissedResultCreatedAt > 0 && latest.createdAt <= dismissedResultCreatedAt) {
          setResultMedia(null);
          setResultTaskRecordId('');
          return false;
        }
        setResultMedia({
          url: latest.resultUrl,
          type: resolveResultMediaType(latest.resultType, latest.resultUrl),
        });
        setResultTaskRecordId(String(latest.id || ''));
        return true;
      } catch {
        setResultMedia(null);
        setResultTaskRecordId('');
        return false;
      }
    };

    const nextDelay = (hasFreshResult: boolean) => {
      const hidden = document.visibilityState !== 'visible';
      if (hasFreshResult) {
        if (round < 6) return hidden ? 4500 : 2800;
        return hidden ? 10000 : 6000;
      }
      return hidden ? 16000 : 9000;
    };

    const runLoop = () => {
      const hasFreshResult = syncLatestResult();
      if (cancelled) return;
      round += 1;
      timer = window.setTimeout(runLoop, nextDelay(hasFreshResult));
    };

    const forceRefresh = () => {
      if (cancelled) return;
      round = 0;
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      runLoop();
    };

    runLoop();
    window.addEventListener('storage', forceRefresh);
    window.addEventListener('focus', forceRefresh);
    document.addEventListener('visibilitychange', forceRefresh);

    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      window.removeEventListener('storage', forceRefresh);
      window.removeEventListener('focus', forceRefresh);
      document.removeEventListener('visibilitychange', forceRefresh);
    };
  }, [workflow, dismissedResultCreatedAt, showResultAfterTs]);

  useEffect(() => {
    setShowResultAfterTs(0);
    setResultMedia(null);
    setResultTaskRecordId('');
    setFileInputs({});
    setFilePreviews((prev) => {
      Object.values(prev).forEach((item) => URL.revokeObjectURL(item.url));
      return {};
    });
  }, [slug]);

  useEffect(() => {
    return () => {
      Object.values(filePreviews).forEach((item) => URL.revokeObjectURL(item.url));
    };
  }, [filePreviews]);

  const handleInputChange = (key: string, value: unknown) => {
    setFormData((prev) => ({ ...prev, [key]: value }));
  };

  const handleFileUpload = (key: string) => (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    setFileInputs((prev) => ({ ...prev, [key]: file }));
    setFilePreviews((prev) => {
      const next = { ...prev };
      if (next[key]) {
        URL.revokeObjectURL(next[key].url);
        delete next[key];
      }
      if (file) {
        const type = file.type.startsWith('image/')
          ? 'image'
          : file.type.startsWith('video/')
            ? 'video'
            : 'audio';
        next[key] = {
          name: file.name,
          type,
          url: URL.createObjectURL(file),
        };
      }
      return next;
    });
  };

  const handleOpenResultInNewTab = () => {
    if (!resultMedia?.url) return;
    window.open(resultMedia.url, '_blank', 'noopener,noreferrer');
  };

  const openUploadViewer = (item: UploadPreviewItem) => {
    setUploadViewer({ open: true, item });
  };

  const closeUploadViewer = () => {
    setUploadViewer({ open: false, item: null });
  };

  const handleViewerVideoFullscreen = async () => {
    const node = viewerVideoRef.current;
    if (!node) return;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await node.requestFullscreen();
      }
    } catch {
      toast.error('进入全屏失败，请使用播放器控件重试');
    }
  };

  const handleCopyResultLink = async () => {
    if (!resultMedia?.url) return;
    try {
      await navigator.clipboard.writeText(resultMedia.url);
      toast.success('结果链接已复制');
    } catch {
      toast.error('复制失败，请手动复制链接');
    }
  };

  const getAudioDurationSeconds = async (file: File): Promise<number> => {
    return await new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const audio = document.createElement('audio');
      audio.preload = 'metadata';
      audio.src = url;
      audio.onloadedmetadata = () => {
        const duration = Number(audio.duration || 0);
        URL.revokeObjectURL(url);
        resolve(Number.isFinite(duration) ? duration : 0);
      };
      audio.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('无法读取音频时长，请更换文件后重试'));
      };
    });
  };

  const validateVoiceStyleAudioLimit = async (inputKey: string, file: File) => {
    if (!workflow || workflow.workflowId !== '2037571485572800513') return;
    const durationSec = await getAudioDurationSeconds(file);
    const maxSec = inputKey === 'audio_ref' ? 30 : 120;
    if (durationSec > maxSec) {
      throw new Error(`${inputKey === 'audio_ref' ? '目标音色音频' : '源音频'}时长超限（当前 ${Math.ceil(durationSec)}s，最大 ${maxSec}s）`);
    }
  };

  const uploadTempFile = async (file: File, inputKey: string) => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('workflowId', String(workflow?.workflowId || ''));
    formData.append('inputKey', inputKey);
    const response = await fetch('/api/files/temp-upload', {
      method: 'POST',
      body: formData,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data?.success || !data?.data?.fileKey) {
      throw new Error(data?.message || '临时文件上传失败');
    }
    return {
      fileKey: String(data.data.fileKey),
      fileName: String(data.data.fileName || file.name || 'upload.bin'),
      contentType: String(data.data.contentType || file.type || 'application/octet-stream'),
      size: Number(data.data.size || file.size || 0),
    };
  };

  const handleGenerate = async () => {
    if (submitInFlightRef.current) return;
    submitInFlightRef.current = true;
    setIsLoading(true);
    setStatusText('正在提交任务，请稍候...');
    if (!workflow) return;
    // 不在这里额外请求 /api/me，避免提交前阻塞。
    // 登录有效性由 /api/tasks/enqueue 返回结果判定（401 时再跳登录）。
    if (workflowDisabled) {
      toast.error(`该应用已下架/维护中${workflowDisabledReason ? `（${workflowDisabledReason}）` : ''}`);
      return;
    }
    if (workflowCenterLocked) {
      toast.error('工作流中心已临时禁用，请等待问题修复后再使用');
      return;
    }
    if (queuePaused) {
      toast.error('任务队列已暂停，请先处理当前异常任务后再继续');
      return;
    }

    const missing = workflow.inputs.find((input) => {
      if (!input.required) return false;

      if (input.type === 'audio' || input.type === 'image' || input.type === 'video') {
        return !fileInputs[input.key];
      }

      if (input.type === 'text') {
        return String(formData[input.key] ?? '').trim() === '';
      }

      if (input.type === 'number') {
        const value = formData[input.key] ?? input.defaultValue;
        return value === undefined || value === null || Number.isNaN(Number(value));
      }

      return !formData[input.key];
    });
    if (missing) {
      const prefix = missing.type === 'audio' || missing.type === 'image' || missing.type === 'video' ? '请上传' : '请输入';
      toast.error(`${prefix} ${missing.label}`);
      return;
    }

    const totalCost = effectiveWorkflowPointCost * generateTimes;
    if (isAuthed && balance === null) {
      toast.info('正在同步积分，请稍候再试');
      return;
    }
    if ((balance ?? 0) < totalCost) {
      toast.error(`积分不足，当前 ${balance} 积分，本次需要 ${totalCost} 积分`);
      return;
    }

    try {
      setDismissedResultCreatedAt(0);
      setShowResultAfterTs(Date.now());
      const inputs: Record<string, unknown> = {};
      for (const input of workflow.inputs) {
        if (input.type === 'audio' || input.type === 'image' || input.type === 'video') {
          const file = fileInputs[input.key];
          if (file) {
            if (input.type === 'audio') {
              await validateVoiceStyleAudioLimit(input.key, file);
            }
            setStatusText(`正在上传 ${input.label}...`);
            const tempFile = await uploadTempFile(file, input.key);
            inputs[input.key] = {
              __rh_file_key: true,
              fileKey: tempFile.fileKey,
              fileName: tempFile.fileName,
              contentType: tempFile.contentType,
              size: tempFile.size,
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
        pointsCost: effectiveWorkflowPointCost,
      };

      const retryKey = buildBatchRetryKey({
        workflowId: workflow.workflowId,
        inputs: payload.inputs,
        generateTimes,
        pointsCost: effectiveWorkflowPointCost,
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
            pointsCost: effectiveWorkflowPointCost,
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
          pointsCost: effectiveWorkflowPointCost,
        payload: { ...payload, requestId: item.requestId },
        createdAt: now + i,
      }));

      const rawHistory = window.localStorage.getItem(HISTORY_KEY);
      const historyList = rawHistory ? JSON.parse(rawHistory) : [];
      const normalizedHistory = Array.isArray(historyList) ? historyList : [];
      const mergedHistory = [...pendingHistory, ...normalizedHistory].slice(0, 100);
      window.localStorage.setItem(HISTORY_KEY, JSON.stringify(mergedHistory));

      const enqueueRes = await fetch('/api/tasks/enqueue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tasks: newTasks }),
      });
      const enqueueData = await enqueueRes.json().catch(() => ({}));
      if (enqueueRes.status === 401) {
        toast.error('登录状态已失效，请重新登录后再试');
        setUserAuthState(false);
        setIsLoading(false);
        return;
      }
      if (!enqueueRes.ok || !enqueueData?.success) {
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

      if (typeof enqueueData?.data?.points === 'number') {
        const nextPoints = Number(enqueueData.data.points);
        setUserBalance(nextPoints);
      }

      if (Number(enqueueData?.data?.queued || 0) === 0) {
        const failReason = Number(enqueueData?.data?.insufficientPoints || 0) > 0
          ? (() => {
              const required = Number(enqueueData?.data?.insufficientRequiredPoints || 0);
              const current = Number(enqueueData?.data?.insufficientCurrentPoints || 0);
              if (required > 0) {
                return `积分不足，任务未入队（当前 ${current}，需要至少 ${required}）`;
              }
              return '积分不足，任务未入队';
            })()
          : Number(enqueueData?.data?.duplicated || 0) > 0
            ? '请求重复，系统已自动去重'
            : '任务入队失败';
        const rollbackHistory = mergedHistory.map((item) =>
          pendingHistory.some((pending) => pending.id === item.id)
            ? {
                ...item,
                status: 'cancelled' as const,
                error: failReason,
                updatedAt: Date.now(),
              }
            : item
        );
        window.localStorage.setItem(HISTORY_KEY, JSON.stringify(rollbackHistory));
        toast.error(failReason);
        setIsLoading(false);
        submitInFlightRef.current = false;
        return;
      }

      enqueueRetryRequestIdsRef.current.delete(retryKey);

      await syncUserState(mergedHistory);

      toast.success(`已入队 ${generateTimes} 次，已预占 ${totalCost} 积分`);
      setStatusText('已入队，任务在后台执行中...');
      setTimeout(() => setStatusText(''), 2600);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : '入队失败';
      toast.error(message);
      setStatusText('');
    } finally {
      setIsLoading(false);
      submitInFlightRef.current = false;
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
            <div className="text-sm text-zinc-700 bg-zinc-100 rounded-full px-3 py-1">
              💰 {balance !== null ? balance : authReady ? (isAuthed ? '同步中...' : '未登录') : '校验中'}
            </div>
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

            {workflowDisabled ? (
              <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
                当前应用已下架/维护中，暂不可提交任务。
                {workflowDisabledReason ? ` 原因：${workflowDisabledReason}` : ''}
              </div>
            ) : null}

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

                  {(input.type === 'audio' || input.type === 'image' || input.type === 'video') && (
                    <div className="space-y-3">
                      <input
                        type="file"
                        accept={
                          input.type === 'audio'
                            ? 'audio/*'
                            : input.type === 'video'
                              ? 'video/*'
                              : 'image/*'
                        }
                        onChange={handleFileUpload(input.key)}
                        className="hidden"
                        id={`file-${input.key}`}
                      />
                      {filePreviews[input.key] ? (
                        <div className="rounded-xl border border-zinc-200 bg-white p-3">
                          {filePreviews[input.key].type === 'image' ? (
                            <img
                              src={filePreviews[input.key].url}
                              alt={filePreviews[input.key].name}
                              className="w-full max-h-56 rounded-lg object-contain bg-white"
                            />
                          ) : filePreviews[input.key].type === 'video' ? (
                            <video
                              src={filePreviews[input.key].url}
                              controls
                              preload="metadata"
                              playsInline
                              className="w-full max-h-56 rounded-lg bg-black"
                            />
                          ) : (
                            <audio
                              src={filePreviews[input.key].url}
                              controls
                              preload="metadata"
                              className="w-full"
                            />
                          )}
                          <p className="mt-2 truncate text-xs text-zinc-500" title={filePreviews[input.key].name}>
                            已选择：{filePreviews[input.key].name}
                          </p>
                          <div className="mt-2 flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => openUploadViewer(filePreviews[input.key])}
                              className="inline-flex h-8 px-3 items-center justify-center rounded-lg border border-zinc-300 bg-white text-zinc-700 text-xs hover:bg-zinc-50"
                            >
                              查看
                            </button>
                            <label
                              htmlFor={`file-${input.key}`}
                              className="inline-flex h-8 px-3 items-center justify-center rounded-lg border border-zinc-300 bg-white text-zinc-700 text-xs cursor-pointer hover:bg-zinc-50"
                            >
                              更换文件
                            </label>
                          </div>
                        </div>
                      ) : null}
                      {!filePreviews[input.key] ? (
                        <label htmlFor={`file-${input.key}`} className="block cursor-pointer border-2 border-dashed border-zinc-300 rounded-xl p-6 text-center text-zinc-600 hover:bg-zinc-50 transition-colors">
                          {input.type === 'audio' ? '点击上传参考音频' : input.type === 'video' ? '点击上传参考视频' : '点击上传参考图片'}
                        </label>
                      ) : null}
                    </div>
                  )}

                  {input.type !== 'text' && input.type !== 'number' && input.type !== 'audio' && input.type !== 'image' && input.type !== 'video' && (
                    <input
                      type="text"
                      value={String(formData[input.key] ?? '')}
                      onChange={(e) => handleInputChange(input.key, e.target.value)}
                      placeholder={input.placeholder || `请输入${input.label}`}
                      className="w-full bg-white border border-zinc-200 rounded-xl p-3 text-zinc-900 placeholder-zinc-400"
                    />
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
              <div className="text-xs text-zinc-500 mt-1">单次扣费：{pointsDisplayText}，本次预计：{totalPointsDisplayText}</div>
              <div className="text-xs text-zinc-500 mt-1">预计时长：{estimatedRuntimeText}（仅供参考）</div>
            </div>

              <button
                onClick={handleGenerate}
                disabled={workflowDisabled || workflowCenterLocked || queuePaused || isLoading || (authReady && !isAuthed)}
                className="mt-6 w-full py-3 rounded-xl btn-brand-gradient disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {isLoading ? '提交中...' : '立即生成'}
              </button>

              {authReady && !isAuthed ? (
                <div className="mt-3 text-sm text-rose-600">当前未登录或登录已失效，请返回首页登录后再生成。</div>
              ) : null}
              {workflowDisabled ? (
                <div className="mt-3 text-sm text-amber-700">该应用已下架/维护中，已禁止提交。</div>
              ) : null}
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
                <div className="mb-3 flex items-center justify-between text-xs text-zinc-500">
                  <span>类型：{getMediaTypeLabel(resultMedia.type)}</span>
                  <span>{getMediaPreviewHint(resultMedia.type)}</span>
                </div>
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
                <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <a
                      href={resultMedia.url}
                      download
                      className="inline-flex h-10 min-w-[110px] items-center justify-center gap-2 px-4 rounded-xl btn-brand-gradient"
                    >
                      <Download className="w-4 h-4" />
                      下载
                    </a>
                    <button
                      onClick={handleOpenResultInNewTab}
                      className="inline-flex h-10 min-w-[120px] items-center justify-center gap-2 px-4 rounded-xl border border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50"
                    >
                      新窗口预览
                    </button>
                    <button
                      onClick={handleCopyResultLink}
                      className="inline-flex h-10 min-w-[100px] items-center justify-center gap-2 px-4 rounded-xl border border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50"
                    >
                      复制链接
                    </button>
                  </div>
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

      {uploadViewer.open && uploadViewer.item ? (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-[1px] p-4 md:p-8" onClick={closeUploadViewer}>
          <div className="mx-auto max-w-5xl h-full flex items-center justify-center" onClick={(e) => e.stopPropagation()}>
            <div className="w-full max-h-full overflow-auto rounded-2xl border border-zinc-700 bg-zinc-950 p-4 md:p-5">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs text-zinc-400">本地预览（未上传到对象存储）</div>
                  <div className="truncate text-sm text-zinc-100" title={uploadViewer.item.name}>{uploadViewer.item.name}</div>
                </div>
                <div className="flex items-center gap-2">
                  {uploadViewer.item.type === 'video' ? (
                    <button
                      type="button"
                      onClick={handleViewerVideoFullscreen}
                      className="inline-flex h-8 px-3 items-center justify-center rounded-lg border border-zinc-600 bg-zinc-900 text-zinc-100 text-xs hover:bg-zinc-800"
                    >
                      全屏
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={closeUploadViewer}
                    className="inline-flex h-8 px-3 items-center justify-center rounded-lg border border-zinc-600 bg-zinc-900 text-zinc-100 text-xs hover:bg-zinc-800"
                  >
                    关闭
                  </button>
                </div>
              </div>

              {uploadViewer.item.type === 'image' ? (
                <img
                  src={uploadViewer.item.url}
                  alt={uploadViewer.item.name}
                  className="w-full max-h-[78vh] rounded-lg object-contain bg-black"
                />
              ) : uploadViewer.item.type === 'video' ? (
                <video
                  ref={viewerVideoRef}
                  src={uploadViewer.item.url}
                  controls
                  playsInline
                  preload="metadata"
                  className="w-full max-h-[78vh] rounded-lg bg-black"
                />
              ) : (
                <div className="rounded-lg bg-zinc-900 p-4">
                  <div className="mb-3 text-sm text-zinc-300">音频独立播放器</div>
                  <audio src={uploadViewer.item.url} controls preload="metadata" className="w-full" />
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
