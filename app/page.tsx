// app/page.tsx
'use client';
/* eslint-disable @next/next/no-img-element */

import { useEffect, useMemo, useRef, useState, type ChangeEvent, type MouseEvent as ReactMouseEvent, type WheelEvent as ReactWheelEvent } from 'react';
import Link from 'next/link';
import {
  Home,
  Clock,
  X,
  Download,
  Trash2,
  Eye,
  Sparkles,
  Inbox,
  ArrowUp,
  ArrowDown,
  ArrowBigUp,
  ArrowBigDown,
  ChevronDown,
  ChevronUp,
  Plus,
  Wallet,
  Search,
  MessageCircle,
} from 'lucide-react';
import { Toaster, toast } from 'sonner';
import { workflows, Workflow, getWorkflowPointCostById } from '@/lib/workflows';

type TaskStatus = 'submitting' | 'queueing' | 'running' | 'success' | 'failed' | 'timeout' | 'cancelled';
type DeliveryStatus = 'none' | 'pending' | 'retrying' | 'delivered' | 'failed';
type ActiveView = 'workflows' | 'history' | 'recharge';
type RechargeTab = 'user' | 'points' | 'referral' | 'help';
type MediaType = 'image' | 'video' | 'audio' | 'unknown';
type HistoryRecordFilter = 'all' | 'success' | 'failed' | 'image' | 'video' | 'audio';

type RetryPayload = {
  workflowId: string;
  workflowTitle: string;
  inputs: Record<string, unknown>;
  isAudioWorkflow: boolean;
  pointsCost?: number;
  requestId?: string;
};

type ResultMedia = {
  url: string;
  type: MediaType;
  fileType?: string;
};

type HistoryItem = {
  id: string;
  requestId: string;
  workflowId: string;
  workflowTitle: string;
  taskId: string | null;
  pointsCost: number;
  status: TaskStatus;
  resultUrl: string | null;
  resultType: MediaType;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  deliveryStatus?: DeliveryStatus;
  deliveryAttempts?: number;
  deliveryLastError?: string | null;
  retryPayload?: RetryPayload;
};

type PointLedgerItem = {
  id: string;
  type: 'income' | 'expense';
  points: number;
  reason: string;
  relatedId?: string;
  createdAt: number;
};

type AuthUser = {
  id: string;
  account: string;
  username: string;
  role: 'user' | 'admin';
  points: number;
  taskBlocked: boolean;
  avatarType?: 'default' | 'upload';
  avatarValue?: string | null;
};

const DEFAULT_AVATAR_OPTIONS = [
  { key: 'ocean', label: '海洋', emoji: '🌊', bgClass: 'from-cyan-500 to-blue-500' },
  { key: 'sunset', label: '日落', emoji: '🌇', bgClass: 'from-orange-400 to-rose-500' },
  { key: 'leaf', label: '森林', emoji: '🌿', bgClass: 'from-emerald-500 to-teal-500' },
  { key: 'violet', label: '紫夜', emoji: '✨', bgClass: 'from-violet-500 to-fuchsia-500' },
  { key: 'ember', label: '熔岩', emoji: '🔥', bgClass: 'from-red-500 to-amber-500' },
  { key: 'graphite', label: '石墨', emoji: '⚫', bgClass: 'from-zinc-500 to-slate-700' },
] as const;

type DefaultAvatarKey = typeof DEFAULT_AVATAR_OPTIONS[number]['key'];

function getDefaultAvatarMeta(key?: string | null) {
  return DEFAULT_AVATAR_OPTIONS.find((item) => item.key === key) || DEFAULT_AVATAR_OPTIONS[0];
}

type QueueTask = {
  id: string;
  requestId: string;
  historyId?: string | null;
  payload: RetryPayload;
  createdAt: number;
  state: 'queued' | 'running';
  submittedTaskId?: string | null;
};

type QueuePauseReason =
  | 'submit_failed'
  | 'status_query_failed'
  | 'task_failed'
  | 'task_timeout'
  | 'missing_output';

function isTerminalHistoryStatus(status: TaskStatus) {
  return status === 'success' || status === 'failed' || status === 'timeout' || status === 'cancelled';
}

function queuePauseMessage(reason: QueuePauseReason) {
  switch (reason) {
    case 'submit_failed':
      return '任务提交失败，队列已暂停，请检查参数或网络后再试。';
    case 'status_query_failed':
      return '任务状态查询失败，队列已暂停，请稍后重试。';
    case 'task_failed':
      return '任务执行失败，队列已暂停，请先处理当前失败任务。';
    case 'task_timeout':
      return '任务执行超时，队列已暂停，请稍后重试。';
    case 'missing_output':
      return '任务已完成但未获取到输出结果，队列已暂停，请先排查输出。';
    default:
      return '队列已暂停，请先处理当前异常任务。';
  }
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

function buildEnqueueRetryKey(payload: RetryPayload) {
  return [
    payload.workflowId,
    String(payload.pointsCost ?? ''),
    stableSerialize(payload.inputs),
  ].join('|');
}

function persistTaskIdToLocalStorage(historyId: string, taskId: string) {
  if (typeof window === 'undefined') return;

  try {
    const rawHistory = window.localStorage.getItem(HISTORY_KEY);
    if (rawHistory) {
      const history = JSON.parse(rawHistory);
      if (Array.isArray(history)) {
        const nextHistory = history.map((item) =>
          item?.id === historyId
            ? {
                ...item,
                taskId,
                status: item.status === 'success' ? 'success' : 'queueing',
                updatedAt: Date.now(),
              }
            : item
        );
        window.localStorage.setItem(HISTORY_KEY, JSON.stringify(nextHistory));
      }
    }

    const rawQueue = window.localStorage.getItem(TASK_QUEUE_KEY);
    if (rawQueue) {
      const queue = JSON.parse(rawQueue);
      if (Array.isArray(queue)) {
        const nextQueue = queue.map((task) =>
          task?.historyId === historyId
            ? {
                ...task,
                submittedTaskId: taskId,
              }
            : task
        );
        window.localStorage.setItem(TASK_QUEUE_KEY, JSON.stringify(nextQueue));
      }
    }
  } catch {
    // ignore local persistence failure
  }
}

export const HISTORY_KEY = 'dundun-history-v1';
const HISTORY_FILTER_KEY = 'dundun-history-filter-v1';
const BALANCE_KEY = 'dundun-balance-v1';
const RECHARGE_RECORDS_KEY = 'dundun-recharge-records-v1';
export const TASK_QUEUE_KEY = 'dundun-task-queue-v1';
export const POINT_LEDGER_KEY = 'dundun-point-ledger-v1';
export const WORKFLOW_CENTER_LOCK_KEY = 'dundun-workflow-center-locked-v1';
export const QUEUE_PAUSE_REASON_KEY = 'dundun-queue-pause-reason-v1';
const QUEUE_PROCESSOR_LOCK_KEY = 'dundun-queue-processor-lock-v1';
const HISTORY_TTL_MS = 15 * 24 * 60 * 60 * 1000;
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const POINT_LEDGER_TTL_MS = 15 * 24 * 60 * 60 * 1000;
const SERVER_QUEUE_EXECUTOR_ENABLED = true;
const ACCOUNT_RE = /^\d{10}$/;
const PASSWORD_RE = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d]{8,10}$/;

type QueueProcessorLock = {
  owner: string;
  ts: number;
};

function statusMeta(status: TaskStatus) {
  switch (status) {
    case 'submitting':
      return { label: '提交中', className: 'bg-zinc-100 text-zinc-700 border border-zinc-300' };
    case 'queueing':
      return { label: '排队中', className: 'bg-amber-50 text-amber-700 border border-amber-200' };
    case 'running':
      return { label: '生成中', className: 'bg-sky-50 text-sky-700 border border-sky-200' };
    case 'success':
      return { label: '成功', className: 'bg-emerald-50 text-emerald-700 border border-emerald-200' };
    case 'failed':
      return { label: '失败', className: 'bg-rose-50 text-rose-700 border border-rose-200' };
    case 'timeout':
      return { label: '超时', className: 'bg-orange-50 text-orange-700 border border-orange-200' };
    case 'cancelled':
      return { label: '已取消', className: 'bg-zinc-100 text-zinc-700 border border-zinc-300' };
    default:
      return { label: '未知', className: 'bg-zinc-100 text-zinc-700 border border-zinc-300' };
  }
}

function formatTime(ts: number) {
  return new Date(ts).toLocaleString();
}

function inferMediaType(url?: string | null, fileType?: string | null): MediaType {
  const t = String(fileType || '').toLowerCase();
  if (['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif', 'avif'].includes(t)) return 'image';
  if (['mp4', 'webm', 'mov', 'mkv', 'avi'].includes(t)) return 'video';
  if (['mp3', 'wav', 'aac', 'm4a', 'ogg', 'flac'].includes(t)) return 'audio';

  const lowerUrl = String(url || '').toLowerCase().split('?')[0];
  if (/(\.jpg|\.jpeg|\.png|\.webp|\.bmp|\.gif|\.avif)$/.test(lowerUrl)) return 'image';
  if (/(\.mp4|\.webm|\.mov|\.mkv|\.avi)$/.test(lowerUrl)) return 'video';
  if (/(\.mp3|\.wav|\.aac|\.m4a|\.ogg|\.flac)$/.test(lowerUrl)) return 'audio';
  return 'unknown';
}

function extractResultMedia(data: unknown): ResultMedia | null {
  const payload = data as {
    image?: string;
    output?: {
      items?: Array<{ fileUrl?: string; fileType?: string }>;
      images?: string[];
      url?: string;
    };
    raw?: {
      data?: Array<{ fileUrl?: string; fileType?: string }>;
      output?: { images?: string[]; url?: string };
    };
  };

  const item = payload.output?.items?.[0] || payload.raw?.data?.[0] || null;
  if (item?.fileUrl) {
    return {
      url: item.fileUrl,
      type: inferMediaType(item.fileUrl, item.fileType),
      fileType: item.fileType,
    };
  }

  const url =
    payload.image ||
    payload.output?.images?.[0] ||
    payload.output?.url ||
    payload.raw?.output?.images?.[0] ||
    payload.raw?.output?.url ||
    payload.raw?.data?.[0]?.fileUrl ||
    null;

  if (!url) return null;
  return { url, type: inferMediaType(url), fileType: undefined };
}

function renderMediaPreview(
  media: ResultMedia,
  className?: string,
  hooks?: {
    onLoad?: () => void;
    onError?: () => void;
  }
) {
  if (media.type === 'image') {
    return (
      <img
        src={media.url}
        alt="生成结果"
        className={className || 'rounded-2xl w-full shadow-lg'}
        onLoad={hooks?.onLoad}
        onError={hooks?.onError}
      />
    );
  }
  if (media.type === 'video') {
    return (
      <video
        src={media.url}
        controls
        className={className || 'rounded-2xl w-full shadow-lg bg-black'}
        onLoadedData={hooks?.onLoad}
        onError={hooks?.onError}
      />
    );
  }
  if (media.type === 'audio') {
    return (
      <div className="rounded-2xl w-full shadow-lg bg-zinc-800 p-4">
        <audio src={media.url} controls className="w-full" onLoadedData={hooks?.onLoad} onError={hooks?.onError} />
      </div>
    );
  }
  return (
    <div className="rounded-2xl w-full shadow-lg bg-zinc-800 p-4 text-sm text-zinc-300 break-all">
      当前文件类型无法内嵌预览，请使用“在新页面打开”。
      <div className="mt-2 text-violet-400">{media.url}</div>
    </div>
  );
}

function inferFileExt(url: string, fallback = 'bin') {
  const clean = String(url || '').split('?')[0].split('#')[0];
  const matched = clean.match(/\.([a-zA-Z0-9]{2,8})$/);
  return (matched?.[1] || fallback).toLowerCase();
}

function buildCrcTable() {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
}

const CRC_TABLE = buildCrcTable();

function crc32(data: Uint8Array) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function toDosDateTime(ts: number) {
  const d = new Date(ts);
  const year = Math.max(1980, d.getFullYear()) - 1980;
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const hour = d.getHours();
  const minute = d.getMinutes();
  const second = Math.floor(d.getSeconds() / 2);
  const dosTime = (hour << 11) | (minute << 5) | second;
  const dosDate = (year << 9) | (month << 5) | day;
  return { dosTime, dosDate };
}

function createZipBlob(entries: Array<{ name: string; data: Uint8Array }>) {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const centralChunks: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const data = entry.data;
    const crc = crc32(data);
    const { dosTime, dosDate } = toDosDateTime(Date.now());

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, dosTime, true);
    localView.setUint16(12, dosDate, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, data.length, true);
    localView.setUint32(22, data.length, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);

    chunks.push(localHeader, data);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, dosTime, true);
    centralView.setUint16(14, dosDate, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, data.length, true);
    centralView.setUint32(24, data.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, offset, true);
    centralHeader.set(nameBytes, 46);
    centralChunks.push(centralHeader);

    offset += localHeader.length + data.length;
  }

  const centralSize = centralChunks.reduce((sum, part) => sum + part.length, 0);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(4, 0, true);
  eocdView.setUint16(6, 0, true);
  eocdView.setUint16(8, entries.length, true);
  eocdView.setUint16(10, entries.length, true);
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, offset, true);
  eocdView.setUint16(20, 0, true);

  const allChunks = [...chunks, ...centralChunks, eocd];
  const totalSize = allChunks.reduce((sum, part) => sum + part.length, 0);
  const zipBytes = new Uint8Array(totalSize);
  let writeOffset = 0;
  for (const part of allChunks) {
    zipBytes.set(part, writeOffset);
    writeOffset += part.length;
  }

  return new Blob([zipBytes], { type: 'application/zip' });
}

export default function DundunPro() {
  const [activeView, setActiveView] = useState<ActiveView>('workflows');
  const [selectedWorkflow, setSelectedWorkflow] = useState<Workflow | null>(null);
  const [formData, setFormData] = useState<Record<string, unknown>>({});
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [statusText, setStatusText] = useState('');
  const [resultMedia, setResultMedia] = useState<ResultMedia | null>(null);
  const [resultMediaHistoryId, setResultMediaHistoryId] = useState('');
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyRecordFilter, setHistoryRecordFilter] = useState<HistoryRecordFilter>('all');
  const [audioProgress, setAudioProgress] = useState(0);
  const [previewMedia, setPreviewMedia] = useState<ResultMedia | null>(null);
  const [taskQueue, setTaskQueue] = useState<QueueTask[]>([]);
  const [taskQueueHydrated, setTaskQueueHydrated] = useState(false);
  const [historyHydrated, setHistoryHydrated] = useState(false);
  const [rechargeRecordsHydrated, setRechargeRecordsHydrated] = useState(false);
  const [pointLedgerHydrated, setPointLedgerHydrated] = useState(false);
  const [queuePanelExpanded, setQueuePanelExpanded] = useState(false);
  const [queuePausedReason, setQueuePausedReason] = useState<QueuePauseReason | null>(null);
  const [workflowCenterLocked, setWorkflowCenterLocked] = useState(false);
  const [showAllUsageInProfile, setShowAllUsageInProfile] = useState(false);
  const [selectedHistoryIds, setSelectedHistoryIds] = useState<string[]>([]);
  const [exportingHistory, setExportingHistory] = useState(false);
  const [previewZoom, setPreviewZoom] = useState(1);
  const [previewOffset, setPreviewOffset] = useState({ x: 0, y: 0 });
  const [isDraggingPreview, setIsDraggingPreview] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [imageLightboxOpen, setImageLightboxOpen] = useState(false);
  const [showAdvisorModal, setShowAdvisorModal] = useState(false);
  const [navigatingSlug, setNavigatingSlug] = useState<string | null>(null);
  const [balance, setBalance] = useState(5);
  const [balanceHydrated, setBalanceHydrated] = useState(false);
  const [selectedWorkflowTag, setSelectedWorkflowTag] = useState('全部');
  const [workflowKeyword, setWorkflowKeyword] = useState('');
  const [rechargeRecords, setRechargeRecords] = useState<Array<{ id: string; points: number; amount: number; createdAt: number }>>([]);
  const [pointLedger, setPointLedger] = useState<PointLedgerItem[]>([]);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [authAccount, setAuthAccount] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authPasswordConfirm, setAuthPasswordConfirm] = useState('');
  const [authError, setAuthError] = useState('');
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [sessionExpiredNotice, setSessionExpiredNotice] = useState('');
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);
  const [rechargeTab, setRechargeTab] = useState<RechargeTab>('user');
  const [selectedRechargeAmount, setSelectedRechargeAmount] = useState<number | null>(null);
  const [customRechargeAmount, setCustomRechargeAmount] = useState('');
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<'wechat' | 'alipay'>('wechat');
  const [pendingRechargeAmount, setPendingRechargeAmount] = useState<number | null>(null);
  const [profileUsername, setProfileUsername] = useState('');
  const [profileSubmitting, setProfileSubmitting] = useState(false);
  const [showAvatarModal, setShowAvatarModal] = useState(false);
  const [avatarSubmitting, setAvatarSubmitting] = useState(false);
  const [avatarMode, setAvatarMode] = useState<'default' | 'upload'>('default');
  const [avatarDefaultKey, setAvatarDefaultKey] = useState<DefaultAvatarKey>('ocean');
  const [avatarUploadDataUrl, setAvatarUploadDataUrl] = useState('');
  const [passwordCurrent, setPasswordCurrent] = useState('');
  const [passwordNext, setPasswordNext] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [passwordSubmitting, setPasswordSubmitting] = useState(false);
  const [showUsernameModal, setShowUsernameModal] = useState(false);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [serverStateHydrated, setServerStateHydrated] = useState(false);

  const audioProgressTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const queueRunnerRef = useRef(false);
  const cancelledHistoryIdsRef = useRef<Set<string>>(new Set());
  const successToastHistoryIdsRef = useRef<Set<string>>(new Set());
  const deliveryAckReportedRef = useRef<Set<string>>(new Set());
  const deliveryFailCooldownRef = useRef<Map<string, number>>(new Map());
  const queueProcessorIdRef = useRef(`proc-${Math.random().toString(36).slice(2, 10)}`);
  const queueLockHeartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const previewContainerRef = useRef<HTMLDivElement | null>(null);
  const avatarFileInputRef = useRef<HTMLInputElement | null>(null);
  const userMenuRef = useRef<HTMLDivElement | null>(null);
  const enqueueRetryRequestIdRef = useRef<Map<string, { requestId: string; expiresAt: number }>>(new Map());
  const session401CountRef = useRef(0);

  const currentWorkflowIsAudio = useMemo(
    () => !!selectedWorkflow?.inputs.some((i) => i.type === 'audio'),
    [selectedWorkflow]
  );
  const authUserId = authUser?.id;
  const authUserPoints = authUser?.points;

  const renderUserAvatar = (sizeClass: string) => {
    const mode = authUser?.avatarType === 'upload' ? 'upload' : 'default';
    const value = String(authUser?.avatarValue || '');

    if (mode === 'upload' && value.startsWith('data:image/')) {
      return <img src={value} alt="头像" className={`${sizeClass} rounded-full object-cover border border-zinc-200 bg-white`} />;
    }

    const meta = getDefaultAvatarMeta(value || 'ocean');
    return (
      <div className={`${sizeClass} rounded-full bg-gradient-to-br ${meta.bgClass} text-white flex items-center justify-center border border-white/40`}>
        <span className="text-base">{meta.emoji}</span>
      </div>
    );
  };

  const reportDeliveryState = (taskRecordId: string, action: 'ack' | 'fail', reason?: string) => {
    if (!taskRecordId) return;

    if (action === 'ack') {
      if (deliveryAckReportedRef.current.has(taskRecordId)) return;
      deliveryAckReportedRef.current.add(taskRecordId);
    } else {
      const now = Date.now();
      const last = deliveryFailCooldownRef.current.get(taskRecordId) || 0;
      if (now - last < 15_000) return;
      deliveryFailCooldownRef.current.set(taskRecordId, now);
    }

    void fetch('/api/tasks/delivery', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskRecordId, action, reason }),
    }).catch(() => undefined);
  };

  const releaseQueueProcessorLock = () => {
    if (typeof window === 'undefined') return;
    if (queueLockHeartbeatRef.current) {
      clearInterval(queueLockHeartbeatRef.current);
      queueLockHeartbeatRef.current = null;
    }

    const raw = window.localStorage.getItem(QUEUE_PROCESSOR_LOCK_KEY);
    if (!raw) return;
    try {
      const lock = JSON.parse(raw) as QueueProcessorLock;
      if (lock.owner === queueProcessorIdRef.current) {
        window.localStorage.removeItem(QUEUE_PROCESSOR_LOCK_KEY);
      }
    } catch {
      // ignore
    }
  };

  const acquireQueueProcessorLock = () => {
    if (typeof window === 'undefined') return true;

    const now = Date.now();
    const staleMs = 15000;
    const owner = queueProcessorIdRef.current;
    let current: QueueProcessorLock | null = null;

    const raw = window.localStorage.getItem(QUEUE_PROCESSOR_LOCK_KEY);
    if (raw) {
      try {
        current = JSON.parse(raw) as QueueProcessorLock;
      } catch {
        current = null;
      }
    }

    const lockActive = current && now - Number(current.ts || 0) < staleMs;
    if (lockActive && current?.owner !== owner) {
      return false;
    }

    const nextLock: QueueProcessorLock = { owner, ts: now };
    window.localStorage.setItem(QUEUE_PROCESSOR_LOCK_KEY, JSON.stringify(nextLock));

    const verifyRaw = window.localStorage.getItem(QUEUE_PROCESSOR_LOCK_KEY);
    if (!verifyRaw) return false;

    try {
      const verify = JSON.parse(verifyRaw) as QueueProcessorLock;
      if (verify.owner !== owner) return false;
    } catch {
      return false;
    }

    if (!queueLockHeartbeatRef.current) {
      queueLockHeartbeatRef.current = setInterval(() => {
        if (!queueRunnerRef.current) return;
        const heartbeat: QueueProcessorLock = { owner, ts: Date.now() };
        window.localStorage.setItem(QUEUE_PROCESSOR_LOCK_KEY, JSON.stringify(heartbeat));
      }, 3000);
    }

    return true;
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch('/api/me', { cache: 'no-store' });
        const data = await response.json().catch(() => null);
        if (!cancelled && data?.success) {
          setAuthUser(data.data);
        }
      } finally {
        if (!cancelled) setAuthLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isUserMenuOpen) return;

    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (userMenuRef.current?.contains(target)) return;
      setIsUserMenuOpen(false);
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
    };
  }, [isUserMenuOpen]);

  useEffect(() => {
    if (!authUser) return;

    let cancelled = false;

    const checkSession = async () => {
      try {
        const response = await fetch('/api/me', { cache: 'no-store' });
        if (cancelled) return;

        if (response.status === 401) {
          session401CountRef.current += 1;
          if (session401CountRef.current < 2) {
            return;
          }
          setAuthUser(null);
          setIsUserMenuOpen(false);
          setShowAvatarModal(false);
          setShowUsernameModal(false);
          setShowPasswordModal(false);
          setSessionExpiredNotice('登录态已失效，已自动返回登录页，请重新登录。');
          toast.error('登录态已失效，请重新登录');
          return;
        }

        session401CountRef.current = 0;

        const data = await response.json().catch(() => null);
        if (data?.success && data?.data) {
          setAuthUser(data.data);
        }
      } catch {
        // ignore network jitter
      }
    };

    const timer = setInterval(() => {
      void checkSession();
    }, 60 * 1000);

    const onFocus = () => {
      void checkSession();
    };

    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void checkSession();
      }
    };

    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [authUser]);

  useEffect(() => {
    setProfileUsername(authUser?.username ?? '');
  }, [authUser?.username]);

  useEffect(() => {
    if (authUserPoints == null) return;
    setBalance(authUserPoints);
  }, [authUserId, authUserPoints]);

  useEffect(() => {
    if (!authUserId) return;

    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch('/api/points/ledger', { cache: 'no-store' });
        const data = await response.json().catch(() => null);
        if (!cancelled && response.ok && data?.success && Array.isArray(data.data)) {
          const mapped: PointLedgerItem[] = data.data.map((row: unknown) => {
            const item = row as {
              id?: unknown;
              delta?: unknown;
              reason?: unknown;
              relatedId?: unknown;
              createdAt?: unknown;
            };

            return {
              id: String(item.id ?? ''),
              type: Number(item.delta) >= 0 ? 'income' : 'expense',
              points: Math.abs(Number(item.delta) || 0),
              reason: String(item.reason ?? ''),
              relatedId: item.relatedId ? String(item.relatedId) : undefined,
              createdAt: new Date(String(item.createdAt ?? Date.now())).getTime(),
            };
          });
          setPointLedger(mapped);
        }
      } catch {
        // ignore
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [authUserId]);

  useEffect(() => {
    if (!authUserId) return;

    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch('/api/me/tasks?page=1&pageSize=200', { cache: 'no-store' });
        const data = await response.json().catch(() => null);
        if (!response.ok || !data?.success || cancelled) return;

        const rows = Array.isArray(data.data?.records) ? data.data.records : [];
        const historyFromServer: HistoryItem[] = rows.map((row: unknown) => {
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
            deliveryAttempts?: unknown;
            deliveryLastError?: unknown;
          };
          let retryPayload: RetryPayload | undefined;
          if (item.payloadJson) {
            try {
              retryPayload = JSON.parse(String(item.payloadJson)) as RetryPayload;
            } catch {
              retryPayload = undefined;
            }
          }

          const createdAt = new Date(String(item.createdAt ?? Date.now())).getTime();
          const updatedAt = new Date(String(item.updatedAt ?? Date.now())).getTime();
          return {
            id: String(item.id ?? ''),
            requestId: String(item.requestId || ''),
            workflowId: String(item.workflowId || ''),
            workflowTitle: String(item.workflowTitle || ''),
            taskId: item.taskId ? String(item.taskId) : null,
            pointsCost: Number(item.pointsCost || 0),
            status: String(item.status || 'queueing') as HistoryItem['status'],
            resultUrl: item.resultUrl ? String(item.resultUrl) : null,
            resultType: (item.resultType ? String(item.resultType) : 'unknown') as HistoryItem['resultType'],
            error: item.error ? String(item.error) : null,
            createdAt,
            updatedAt,
            retryPayload,
          };
        });

        if (historyFromServer.length > 0) {
          setHistory(historyFromServer.sort((a, b) => b.createdAt - a.createdAt));
        }

        const queueFromServer: QueueTask[] = historyFromServer
          .filter((item) => ['queueing', 'submitting', 'running'].includes(item.status))
          .map((item) => ({
            id: `srv-${item.id}`,
            requestId: item.requestId,
            historyId: item.id,
            payload:
              item.retryPayload || {
                workflowId: item.workflowId,
                workflowTitle: item.workflowTitle,
                inputs: {},
                isAudioWorkflow: false,
                pointsCost: item.pointsCost,
                requestId: item.requestId,
              },
            createdAt: item.createdAt,
            state: item.status === 'running' ? 'running' : 'queued',
            submittedTaskId: item.taskId,
          }));

        if (queueFromServer.length > 0) {
          setTaskQueue(queueFromServer);
        }
      } catch {
        // ignore
      } finally {
        if (!cancelled) setServerStateHydrated(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [authUserId]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(HISTORY_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as HistoryItem[];
        if (Array.isArray(parsed)) {
          const now = Date.now();
          const filtered = parsed
            .map((i) => {
              const createdAt = Number(i.createdAt || i.updatedAt || now);
              const safeCreatedAt = Number.isFinite(createdAt) ? createdAt : now;
              return {
                ...i,
                requestId: typeof i.requestId === 'string' && i.requestId ? i.requestId : createRequestId(),
                createdAt: safeCreatedAt,
                updatedAt: Number(i.updatedAt || safeCreatedAt),
                pointsCost: typeof i.pointsCost === 'number' ? i.pointsCost : 0,
                resultType: i.resultType || inferMediaType(i.resultUrl),
                retryPayload: undefined,
              };
            })
            .filter((i) => now - i.createdAt <= HISTORY_TTL_MS);
          setHistory(filtered.sort((a, b) => b.createdAt - a.createdAt));
        }
      }
    } catch {
      // ignore parse errors
    } finally {
      setHistoryHydrated(true);
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const rawBalance = window.localStorage.getItem(BALANCE_KEY);
    if (rawBalance) {
      const parsed = Number(rawBalance);
      if (!Number.isNaN(parsed) && parsed >= 0) setBalance(parsed);
    }

    const rawRecords = window.localStorage.getItem(RECHARGE_RECORDS_KEY);
    if (rawRecords) {
      try {
        const parsed = JSON.parse(rawRecords);
        if (Array.isArray(parsed)) {
          const now = Date.now();
          const normalized = parsed
            .map((r) => {
              const createdAt = Number(r?.createdAt || now);
              return {
                ...r,
                createdAt: Number.isFinite(createdAt) ? createdAt : now,
              };
            })
            .filter((r) => now - r.createdAt <= ONE_YEAR_MS);
          setRechargeRecords(normalized);
        }
      } catch {
        // ignore
      }
    }
    setRechargeRecordsHydrated(true);

    const rawLedger = window.localStorage.getItem(POINT_LEDGER_KEY);
    if (rawLedger) {
      try {
        const parsed = JSON.parse(rawLedger);
        if (Array.isArray(parsed)) {
          const now = Date.now();
          const normalized = parsed
            .map((r) => {
              const createdAt = Number(r?.createdAt || now);
              return {
                ...r,
                createdAt: Number.isFinite(createdAt) ? createdAt : now,
              };
            })
            .filter((r) => now - r.createdAt <= POINT_LEDGER_TTL_MS);
          setPointLedger(normalized);
        }
      } catch {
        // ignore
      }
    }
    setPointLedgerHydrated(true);

    const rawQueue = window.localStorage.getItem(TASK_QUEUE_KEY);
    if (rawQueue) {
      try {
        const parsed = JSON.parse(rawQueue);
        if (Array.isArray(parsed)) {
          let historyTaskIdMap: Record<string, string> = {};
          const rawHistory = window.localStorage.getItem(HISTORY_KEY);
          if (rawHistory) {
            try {
              const historyParsed = JSON.parse(rawHistory);
              if (Array.isArray(historyParsed)) {
                historyTaskIdMap = historyParsed.reduce((acc, item) => {
                  if (item?.id && typeof item?.taskId === 'string' && item.taskId) {
                    acc[item.id] = item.taskId;
                  }
                  return acc;
                }, {} as Record<string, string>);
              }
            } catch {
              historyTaskIdMap = {};
            }
          }

          const normalized = parsed
            .filter((t) => t && typeof t === 'object' && t.id && t.payload)
            .map((t) => ({
              ...t,
              requestId: typeof t.requestId === 'string' && t.requestId ? t.requestId : createRequestId(),
              submittedTaskId:
                typeof t.submittedTaskId === 'string' && t.submittedTaskId
                  ? t.submittedTaskId
                  : (t.historyId && historyTaskIdMap[t.historyId]) || null,
              state: t.state === 'running' ? 'queued' : 'queued',
            }));
          setTaskQueue(normalized);
        }
      } catch {
        // ignore
      }
    }

    const rawCenterLock = window.localStorage.getItem(WORKFLOW_CENTER_LOCK_KEY);
    if (rawCenterLock === '1') setWorkflowCenterLocked(true);

    const rawPause = window.localStorage.getItem(QUEUE_PAUSE_REASON_KEY);
    if (rawPause && ['submit_failed', 'status_query_failed', 'task_failed', 'task_timeout', 'missing_output'].includes(rawPause)) {
      setQueuePausedReason(rawPause as QueuePauseReason);
    }

    setBalanceHydrated(true);
    setTaskQueueHydrated(true);
  }, []);

  // 恢复历史筛选条件（刷新后保留）
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(HISTORY_FILTER_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as {
        recordFilter?: HistoryRecordFilter;
      };
      if (
        parsed.recordFilter &&
        ['all', 'success', 'failed', 'image', 'video', 'audio'].includes(parsed.recordFilter)
      ) {
        setHistoryRecordFilter(parsed.recordFilter);
      }
    } catch {
      // ignore parse errors
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!historyHydrated) return;
    const now = Date.now();
    const lightweight = history
      .filter((i) => now - i.createdAt <= HISTORY_TTL_MS)
      .map((item) => {
        const rest = { ...item };
        delete rest.retryPayload;
        return rest;
      })
      .slice(0, 100);
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(lightweight));
  }, [history, historyHydrated]);

  // 持久化历史筛选条件
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(
      HISTORY_FILTER_KEY,
      JSON.stringify({
        recordFilter: historyRecordFilter,
      })
    );
  }, [historyRecordFilter]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!balanceHydrated) return;
    window.localStorage.setItem(BALANCE_KEY, String(balance));
  }, [balance, balanceHydrated]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!rechargeRecordsHydrated) return;
    const now = Date.now();
    const filtered = rechargeRecords.filter((r) => now - r.createdAt <= ONE_YEAR_MS).slice(0, 300);
    window.localStorage.setItem(RECHARGE_RECORDS_KEY, JSON.stringify(filtered));
    if (filtered.length !== rechargeRecords.length) {
      setRechargeRecords(filtered);
    }
  }, [rechargeRecords, rechargeRecordsHydrated]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!pointLedgerHydrated) return;
    const now = Date.now();
    const filtered = pointLedger.filter((row) => now - row.createdAt <= POINT_LEDGER_TTL_MS).slice(0, 200);
    window.localStorage.setItem(POINT_LEDGER_KEY, JSON.stringify(filtered));
    if (filtered.length !== pointLedger.length) {
      setPointLedger(filtered);
    }
  }, [pointLedger, pointLedgerHydrated]);

  useEffect(() => {
    const historyIdSet = new Set(history.map((item) => item.id));
    setSelectedHistoryIds((prev) => prev.filter((id) => historyIdSet.has(id)));
  }, [history]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!taskQueueHydrated) return;
    const lightweight = taskQueue.map(({ payload, ...rest }) => ({
      ...rest,
      payload,
    }));
    window.localStorage.setItem(TASK_QUEUE_KEY, JSON.stringify(lightweight));
  }, [taskQueue, taskQueueHydrated]);

  useEffect(() => {
    if (SERVER_QUEUE_EXECUTOR_ENABLED) return;
    if (!authUserId) return;
    if (!historyHydrated || !taskQueueHydrated || !serverStateHydrated) return;

    const timer = setTimeout(() => {
      void fetch('/api/me/tasks', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tasks: history,
        }),
      });
    }, 300);

    return () => clearTimeout(timer);
  }, [authUserId, history, taskQueue, historyHydrated, taskQueueHydrated, serverStateHydrated]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(WORKFLOW_CENTER_LOCK_KEY, workflowCenterLocked ? '1' : '0');
  }, [workflowCenterLocked]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!queuePausedReason) {
      window.localStorage.removeItem(QUEUE_PAUSE_REASON_KEY);
      return;
    }
    window.localStorage.setItem(QUEUE_PAUSE_REASON_KEY, queuePausedReason);
  }, [queuePausedReason]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const onStorage = (event: StorageEvent) => {
      if (event.storageArea !== window.localStorage) return;

      if (event.key === TASK_QUEUE_KEY && event.newValue) {
        try {
          const parsed = JSON.parse(event.newValue);
          if (Array.isArray(parsed)) {
            setTaskQueue(parsed as QueueTask[]);
          }
        } catch {
          // ignore
        }
      }

      if (event.key === WORKFLOW_CENTER_LOCK_KEY) {
        setWorkflowCenterLocked(event.newValue === '1');
      }

      if (event.key === QUEUE_PAUSE_REASON_KEY) {
        if (
          event.newValue &&
          ['submit_failed', 'status_query_failed', 'task_failed', 'task_timeout', 'missing_output'].includes(event.newValue)
        ) {
          setQueuePausedReason(event.newValue as QueuePauseReason);
        } else {
          setQueuePausedReason(null);
        }
      }
    };

    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  useEffect(() => {
    return () => {
      releaseQueueProcessorLock();
      if (audioProgressTimerRef.current) {
        clearInterval(audioProgressTimerRef.current);
        audioProgressTimerRef.current = null;
      }
    };
  }, []);

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

  const startAudioProgress = () => {
    if (audioProgressTimerRef.current) clearInterval(audioProgressTimerRef.current);
    setAudioProgress(6);
    audioProgressTimerRef.current = setInterval(() => {
      setAudioProgress((prev) => {
        if (prev >= 94) return prev;
        return Math.min(94, prev + Math.max(1, Math.floor(Math.random() * 6)));
      });
    }, 800);
  };

  const stopAudioProgress = (success: boolean) => {
    if (audioProgressTimerRef.current) {
      clearInterval(audioProgressTimerRef.current);
      audioProgressTimerRef.current = null;
    }

    if (success) {
      setAudioProgress(100);
      setTimeout(() => setAudioProgress(0), 800);
    } else {
      setAudioProgress(0);
    }
  };

  const addHistoryItem = (item: HistoryItem) => {
    setHistory((prev) => [...prev, item].sort((a, b) => b.createdAt - a.createdAt).slice(0, 100));
  };

  const updateHistoryItem = (id: string, patch: Partial<HistoryItem>) => {
    setHistory((prev) =>
      prev.map((item) =>
        item.id === id
          ? {
              ...item,
              ...patch,
              updatedAt: Date.now(),
            }
          : item
      )
    );
  };

  const addPointLedgerItem = (item: Omit<PointLedgerItem, 'id' | 'createdAt'>) => {
    setPointLedger((prev) => [
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        createdAt: Date.now(),
        ...item,
      },
      ...prev,
    ].slice(0, 200));
  };

  const runTaskNow = async (
    payload: RetryPayload,
    historyId: string,
    requestId: string
  ): Promise<'ok' | QueuePauseReason> => {
    setIsLoading(true);
    setStatusText('正在提交任务...');
    setResultMedia(null);
    setResultMediaHistoryId('');

    if (payload.isAudioWorkflow) startAudioProgress();
    else setAudioProgress(0);

    try {
      const res = await fetch('/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workflowId: payload.workflowId,
          inputs: payload.inputs,
          requestId,
        }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        const err = data.error || `提交任务失败（${res.status}）`;
        updateHistoryItem(historyId, { status: 'failed', error: err });
        toast.error(err);
        setIsLoading(false);
        setStatusText('');
        stopAudioProgress(false);
        return 'submit_failed';
      }

      const newTaskId =
        data.task_id ||
        data.taskId ||
        data.id ||
        data?.raw?.task_id ||
        data?.raw?.taskId ||
        data?.raw?.id ||
        data?.raw?.data?.taskId ||
        null;

      if (newTaskId) {
        setStatusText('任务已提交，排队中...');
        updateHistoryItem(historyId, { taskId: newTaskId, status: 'queueing' });
        setTaskQueue((prev) =>
          prev.map((t) => (t.historyId === historyId ? { ...t, submittedTaskId: newTaskId } : t))
        );
        persistTaskIdToLocalStorage(historyId, newTaskId);
        toast.success('任务已提交，正在生成中...');
        return await pollTaskStatus(newTaskId, historyId, payload.isAudioWorkflow);
      }

      const directMedia = extractResultMedia(data);
      if (directMedia) {
        setResultMedia(directMedia);
        setResultMediaHistoryId(historyId);
        setIsLoading(false);
        setStatusText('');
        stopAudioProgress(true);
        updateHistoryItem(historyId, {
          status: 'success',
          resultUrl: directMedia.url,
          resultType: directMedia.type,
          error: null,
        });
        toast.success('生成成功！');
        return 'ok';
      }

      const err = data.error || '未返回任务ID';
      updateHistoryItem(historyId, { status: 'failed', error: err });
      toast.error(err);
      setIsLoading(false);
      setStatusText('');
      stopAudioProgress(false);
      return 'submit_failed';
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : '提交失败';
      toast.error(message);
      setIsLoading(false);
      setStatusText('');
      stopAudioProgress(false);
      return 'submit_failed';
    }
  };

  const runTask = async (payload: RetryPayload) => {
    if (workflowCenterLocked) {
      toast.error('工作流中心已临时禁用，请等待问题修复后再使用');
      return;
    }

    if (queuePausedReason) {
      toast.error(queuePauseMessage(queuePausedReason));
      return;
    }

    const pointsCost = payload.pointsCost ?? getWorkflowPointCostById(payload.workflowId);

    if (balance < pointsCost) {
      toast.error(`积分不足，当前 ${balance} 积分，本次需要 ${pointsCost} 积分`);
      return;
    }

    try {
      const consumeRes = await fetch('/api/points/consume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          points: pointsCost,
          reason: `工作流入队：${payload.workflowTitle}`,
          relatedId: payload.workflowId,
        }),
      });
      const consumeData = await consumeRes.json().catch(() => ({}));
      if (!consumeRes.ok || !consumeData?.success) {
        toast.error(consumeData?.message || '扣费失败，请稍后重试');
        return;
      }
      setBalance(Number(consumeData?.data?.points ?? Math.max(0, balance - pointsCost)));
      addPointLedgerItem({
        type: 'expense',
        points: pointsCost,
        reason: `工作流入队：${payload.workflowTitle}`,
        relatedId: payload.workflowId,
      });
    } catch {
      toast.error('扣费失败，请稍后重试');
      return;
    }

    const historyId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const retryKey = buildEnqueueRetryKey(payload);
    const cachedRetry = enqueueRetryRequestIdRef.current.get(retryKey);
    const canReuseCached =
      !payload.requestId &&
      !!cachedRetry?.requestId &&
      Number(cachedRetry?.expiresAt || 0) > Date.now();
    const requestId = payload.requestId || (canReuseCached ? String(cachedRetry?.requestId || '') : '') || createRequestId();

    if (!payload.requestId) {
      enqueueRetryRequestIdRef.current.set(retryKey, {
        requestId,
        expiresAt: Date.now() + REQUEST_ID_REUSE_WINDOW_MS,
      });
    }

    addHistoryItem({
      id: historyId,
      requestId,
      workflowId: payload.workflowId,
      workflowTitle: payload.workflowTitle,
      taskId: null,
      pointsCost,
      status: 'queueing',
      resultUrl: null,
      resultType: 'unknown',
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      retryPayload: payload,
    });

    if (SERVER_QUEUE_EXECUTOR_ENABLED) {
      try {
        const enqueueRes = await fetch('/api/tasks/enqueue', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tasks: [
              {
                id: historyId,
                requestId,
                workflowId: payload.workflowId,
                workflowTitle: payload.workflowTitle,
                pointsCost,
                payload: { ...payload, requestId },
                createdAt: Date.now(),
              },
            ],
          }),
        });
        const enqueueData = await enqueueRes.json().catch(() => ({}));
        if (!enqueueRes.ok || !enqueueData?.success) {
          enqueueRetryRequestIdRef.current.set(retryKey, {
            requestId,
            expiresAt: Date.now() + REQUEST_ID_REUSE_WINDOW_MS,
          });
          await fetch('/api/points/refund', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              points: pointsCost,
              reason: `入队失败返还：${payload.workflowTitle}`,
              relatedId: payload.workflowId,
            }),
          }).catch(() => undefined);
          toast.error(enqueueData?.message || '任务入队失败');
          return;
        }

        enqueueRetryRequestIdRef.current.delete(retryKey);

        setTaskQueue((prev) => [
          ...prev,
          {
            id: `srv-${historyId}`,
            requestId,
            historyId,
            payload: { ...payload, requestId },
            createdAt: Date.now(),
            state: 'queued',
            submittedTaskId: null,
          },
        ]);
        toast.info(`任务已入队，已扣除 ${pointsCost} 积分`);
        return;
      } catch {
        enqueueRetryRequestIdRef.current.set(retryKey, {
          requestId,
          expiresAt: Date.now() + REQUEST_ID_REUSE_WINDOW_MS,
        });
        toast.error('任务入队失败，请稍后重试');
        return;
      }
    }

    toast.info(`任务已入队，已扣除 ${pointsCost} 积分`);
  };

  useEffect(() => {
    if (SERVER_QUEUE_EXECUTOR_ENABLED) return;
    if (queueRunnerRef.current) return;
    if (queuePausedReason) return;

    const next = taskQueue.find((t) => t.state === 'queued');
    if (!next) return;

    if (!acquireQueueProcessorLock()) {
      return;
    }

    queueRunnerRef.current = true;
    setTaskQueue((prev) => prev.map((t) => (t.id === next.id ? { ...t, state: 'running' } : t)));
    const pointsCost = next.payload.pointsCost ?? getWorkflowPointCostById(next.payload.workflowId);
    const requestId = next.requestId || next.payload.requestId || createRequestId();
    const historySnapshot = next.historyId ? history.find((item) => item.id === next.historyId) : null;
    const recoveredTaskId = next.submittedTaskId || historySnapshot?.taskId || null;
    const effectiveHistoryId = next.historyId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-ext`;

    if (next.historyId) {
      setHistory((prev) => {
        const exists = prev.some((item) => item.id === next.historyId);
        if (exists) {
          return prev.map((item) =>
            item.id === next.historyId
              ? {
                  ...item,
                  status: 'submitting',
                  error: null,
                  updatedAt: Date.now(),
                }
              : item
          );
        }

        return [
          {
            id: effectiveHistoryId,
            requestId,
            workflowId: next.payload.workflowId,
            workflowTitle: next.payload.workflowTitle,
            taskId: null,
            pointsCost,
            status: 'submitting',
            resultUrl: null,
            resultType: 'unknown',
            error: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            retryPayload: next.payload,
          } satisfies HistoryItem,
          ...prev,
        ].slice(0, 100);
      });
    } else {
      addHistoryItem({
        id: effectiveHistoryId,
        requestId,
        workflowId: next.payload.workflowId,
        workflowTitle: next.payload.workflowTitle,
        taskId: null,
        pointsCost,
        status: 'submitting',
        resultUrl: null,
        resultType: 'unknown',
        error: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        retryPayload: next.payload,
      });
    }

    void (async () => {
      let outcome: 'ok' | QueuePauseReason = 'ok';
      try {
        if (recoveredTaskId) {
          setStatusText('任务恢复中，正在继续查询状态...');
          outcome = await pollTaskStatus(recoveredTaskId, effectiveHistoryId, next.payload.isAudioWorkflow);
        } else {
          outcome = await runTaskNow(next.payload, effectiveHistoryId, requestId);
        }
      } finally {
        setTaskQueue((prev) => prev.filter((t) => t.id !== next.id));
        if (outcome !== 'ok') {
          setQueuePausedReason(outcome);
          if (outcome === 'missing_output') {
            setWorkflowCenterLocked(true);
          }
          toast.error(queuePauseMessage(outcome));
        }
        queueRunnerRef.current = false;
        releaseQueueProcessorLock();
      }
    })();
  }, [taskQueue, queuePausedReason, history]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!SERVER_QUEUE_EXECUTOR_ENABLED) return;
    if (!authUserId) return;

    let cancelled = false;
    const sync = async () => {
      try {
        const response = await fetch('/api/me/tasks?page=1&pageSize=200', { cache: 'no-store' });
        const data = await response.json().catch(() => null);
        if (!response.ok || !data?.success || cancelled) return;
        const rows = Array.isArray(data.data?.records) ? data.data.records : [];

        const mappedHistory: HistoryItem[] = rows.map((row: unknown) => {
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
            deliveryAttempts?: unknown;
            deliveryLastError?: unknown;
          };

          let retryPayload: RetryPayload | undefined;
          if (item.payloadJson) {
            try {
              retryPayload = JSON.parse(String(item.payloadJson)) as RetryPayload;
            } catch {
              retryPayload = undefined;
            }
          }

          return {
            id: String(item.id ?? ''),
            requestId: String(item.requestId || ''),
            workflowId: String(item.workflowId || ''),
            workflowTitle: String(item.workflowTitle || ''),
            taskId: item.taskId ? String(item.taskId) : null,
            pointsCost: Number(item.pointsCost || 0),
            status: String(item.status || 'queueing') as HistoryItem['status'],
            resultUrl: item.resultUrl ? String(item.resultUrl) : null,
            resultType: (item.resultType ? String(item.resultType) : 'unknown') as HistoryItem['resultType'],
            error: item.error ? String(item.error) : null,
            createdAt: new Date(String(item.createdAt ?? Date.now())).getTime(),
            updatedAt: new Date(String(item.updatedAt ?? Date.now())).getTime(),
            deliveryStatus: (item.deliveryStatus ? String(item.deliveryStatus) : 'none') as DeliveryStatus,
            deliveryAttempts: Number(item.deliveryAttempts || 0),
            deliveryLastError: item.deliveryLastError ? String(item.deliveryLastError) : null,
            retryPayload,
          };
        });

        setHistory(mappedHistory.sort((a, b) => b.createdAt - a.createdAt));

        const mappedQueue: QueueTask[] = mappedHistory
          .filter((item) => ['queueing', 'submitting', 'running'].includes(item.status))
          .map((item) => ({
            id: `srv-${item.id}`,
            requestId: item.requestId,
            historyId: item.id,
            payload: item.retryPayload || {
              workflowId: item.workflowId,
              workflowTitle: item.workflowTitle,
              inputs: {},
              isAudioWorkflow: false,
              pointsCost: item.pointsCost,
              requestId: item.requestId,
            },
            createdAt: item.createdAt,
            state: (item.status === 'running' ? 'running' : 'queued') as QueueTask['state'],
            submittedTaskId: item.taskId,
          }))
          .sort((a, b) => {
            if (a.state === 'running' && b.state !== 'running') return -1;
            if (a.state !== 'running' && b.state === 'running') return 1;
            return a.createdAt - b.createdAt;
          });
        setTaskQueue(mappedQueue);
      } catch {
        // ignore
      }
    };

    void sync();
    const timer = setInterval(() => {
      void sync();
    }, 2500);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [authUserId]);

  const handleGenerate = async () => {
    if (!selectedWorkflow) return;

    const missing = selectedWorkflow.inputs.find((i) => i.type === 'text' && !formData[i.key]);
    if (missing) {
      toast.error(`请输入 ${missing.label}`);
      return;
    }

    const inputs: Record<string, unknown> = {};

    for (const input of selectedWorkflow.inputs) {
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

    await runTask({
      workflowId: selectedWorkflow.workflowId,
      workflowTitle: selectedWorkflow.title,
      inputs: JSON.parse(JSON.stringify(inputs)),
      isAudioWorkflow: selectedWorkflow.inputs.some((i) => i.type === 'audio'),
      pointsCost: getWorkflowPointCostById(selectedWorkflow.workflowId),
    });
  };

  const retryHistoryItem = async (item: HistoryItem) => {
    if (!item.retryPayload) {
      toast.error('该记录无重试参数（可能是刷新后历史），请重新手动提交一次');
      return;
    }

    await runTask({ ...item.retryPayload, requestId: createRequestId() });
  };

  const cancelQueuedTask = (queueId: string) => {
    const target = taskQueue.find((t) => t.id === queueId);
    if (!target) return;

    if (SERVER_QUEUE_EXECUTOR_ENABLED) {
      void (async () => {
        try {
          const recordId = target.historyId || (queueId.startsWith('srv-') ? queueId.slice(4) : queueId);
          const response = await fetch('/api/tasks/cancel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: recordId }),
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok || !data?.success) {
            toast.error(data?.message || '取消任务失败');
            return;
          }

          setTaskQueue((prev) => prev.filter((t) => t.id !== queueId));
          if (target.historyId) {
            updateHistoryItem(target.historyId, {
              status: 'cancelled',
              error: '任务已取消（服务端队列）',
            });
          }

          const refundPoints = Number(data?.data?.pointsCost || 0);
          if (refundPoints > 0) {
            setBalance((prev) => prev + refundPoints);
          }
          toast.success('任务已取消');
        } catch {
          toast.error('取消任务失败，请稍后重试');
        }
      })();
      return;
    }

    if (target.state === 'running') {
      toast.error('执行中任务不支持手动取消，系统将按失败规则自动暂停后续任务');
      return;
    }

    const refundPoints = target.payload.pointsCost ?? getWorkflowPointCostById(target.payload.workflowId);

    void (async () => {
      try {
        const refundRes = await fetch('/api/points/refund', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            points: Math.max(0, refundPoints),
            reason: `排队取消返还：${target.payload.workflowTitle}`,
            relatedId: target.payload.workflowId,
          }),
        });
        const refundData = await refundRes.json().catch(() => ({}));
        if (!refundRes.ok || !refundData?.success) {
          toast.error(refundData?.message || '返还积分失败，请稍后再试');
          return;
        }

        setTaskQueue((prev) => prev.filter((t) => t.id !== queueId));
        setBalance(Number(refundData?.data?.points ?? balance + Math.max(0, refundPoints)));
        addPointLedgerItem({
          type: 'income',
          points: Math.max(0, refundPoints),
          reason: `排队取消返还：${target.payload.workflowTitle}`,
          relatedId: target.payload.workflowId,
        });
        if (target.historyId) {
          updateHistoryItem(target.historyId, {
            status: 'cancelled',
            error: '任务已取消（未执行，已返还该任务消耗的积分）',
          });
        }
        toast.success(`已取消排队任务，返还 ${refundPoints} 积分`);
      } catch {
        toast.error('返还积分失败，请稍后再试');
      }
    })();
  };

  const promoteQueuedTask = (queueId: string) => {
    setTaskQueue((prev) => {
      const target = prev.find((t) => t.id === queueId);
      if (!target) return prev;

      if (target.state === 'running') {
        toast.error('执行中任务不能上移');
        return prev;
      }

      const queued = prev.filter((t) => t.state === 'queued');
      const running = prev.filter((t) => t.state === 'running');

      const currentIndex = queued.findIndex((t) => t.id === queueId);
      if (currentIndex <= 0) {
        toast.info('该任务已在队首');
        return prev;
      }

      const [picked] = queued.splice(currentIndex, 1);
      queued.unshift(picked);
      toast.success('已上移到队首');
      return [...running, ...queued];
    });
  };

  const moveQueuedTaskUpOne = (queueId: string) => {
    setTaskQueue((prev) => {
      const target = prev.find((t) => t.id === queueId);
      if (!target) return prev;

      if (target.state === 'running') {
        toast.error('执行中任务不能上移');
        return prev;
      }

      const queued = prev.filter((t) => t.state === 'queued');
      const running = prev.filter((t) => t.state === 'running');

      const idx = queued.findIndex((t) => t.id === queueId);
      if (idx <= 0) {
        toast.info('该任务已在队首');
        return prev;
      }

      const temp = queued[idx - 1];
      queued[idx - 1] = queued[idx];
      queued[idx] = temp;

      toast.success('已上移一位');
      return [...running, ...queued];
    });
  };

  const moveQueuedTaskDownOne = (queueId: string) => {
    setTaskQueue((prev) => {
      const target = prev.find((t) => t.id === queueId);
      if (!target) return prev;

      if (target.state === 'running') {
        toast.error('执行中任务不能下移');
        return prev;
      }

      const queued = prev.filter((t) => t.state === 'queued');
      const running = prev.filter((t) => t.state === 'running');

      const idx = queued.findIndex((t) => t.id === queueId);
      if (idx < 0 || idx >= queued.length - 1) {
        toast.info('该任务已在队尾');
        return prev;
      }

      const temp = queued[idx + 1];
      queued[idx + 1] = queued[idx];
      queued[idx] = temp;

      toast.success('已下移一位');
      return [...running, ...queued];
    });
  };

  const demoteQueuedTask = (queueId: string) => {
    setTaskQueue((prev) => {
      const target = prev.find((t) => t.id === queueId);
      if (!target) return prev;

      if (target.state === 'running') {
        toast.error('执行中任务不能置底');
        return prev;
      }

      const queued = prev.filter((t) => t.state === 'queued');
      const running = prev.filter((t) => t.state === 'running');

      const idx = queued.findIndex((t) => t.id === queueId);
      if (idx < 0 || idx === queued.length - 1) {
        toast.info('该任务已在队尾');
        return prev;
      }

      const [picked] = queued.splice(idx, 1);
      queued.push(picked);
      toast.success('已置底');
      return [...running, ...queued];
    });
  };

  const pollTaskStatus = (id: string, historyId: string, isAudioWorkflow: boolean): Promise<'ok' | QueuePauseReason> => {
    let attempts = 0;
    const maxAttempts = 300;

    return new Promise((resolve) => {
      const interval = setInterval(async () => {
      if (cancelledHistoryIdsRef.current.has(historyId)) {
        cancelledHistoryIdsRef.current.delete(historyId);
        clearInterval(interval);
        setIsLoading(false);
        setStatusText('');
        if (isAudioWorkflow) stopAudioProgress(false);
        resolve('ok');
        return;
      }

      attempts++;

      try {
        const res = await fetch(`/api/task-status?taskId=${encodeURIComponent(id)}`, {
          cache: 'no-store',
        });
        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          clearInterval(interval);
          setIsLoading(false);
          setStatusText('');
          if (isAudioWorkflow) stopAudioProgress(false);
          const err = data.error || `查询任务状态失败（${res.status}）`;
          updateHistoryItem(historyId, { status: 'failed', error: err });
          toast.error(err);
          resolve('status_query_failed');
          return;
        }

        const status = String(data.status || '').toLowerCase();
        const phase = String(data.phase || '').toLowerCase();
        const message = String(data.message || '').toUpperCase();

        if (status === 'running') {
          if (phase === 'queueing' || message.includes('QUEUE')) {
            setStatusText('排队中，请稍候...');
            updateHistoryItem(historyId, { status: 'queueing' });
          } else {
            setStatusText('生成中，请稍候...');
            updateHistoryItem(historyId, { status: 'running' });
          }
        }

        if (status === 'success' || status === 'completed' || status === 'done') {
          clearInterval(interval);
          const media = extractResultMedia(data);

          if (media) {
            setResultMedia(media);
            setResultMediaHistoryId(historyId);
            if (!successToastHistoryIdsRef.current.has(historyId)) {
              successToastHistoryIdsRef.current.add(historyId);
              toast.success('生成成功！');
            }
            updateHistoryItem(historyId, {
              status: 'success',
              resultUrl: media.url,
              resultType: media.type,
              error: null,
            });
            resolve('ok');
          } else {
            toast.error('任务完成，但未返回结果链接');
            updateHistoryItem(historyId, {
              status: 'failed',
              error: '任务完成，但未返回结果链接',
            });
            resolve('missing_output');
          }

          setIsLoading(false);
          setStatusText('');
          if (isAudioWorkflow) stopAudioProgress(true);
          return;
        }

        if (status === 'failed') {
          clearInterval(interval);
          setIsLoading(false);
          setStatusText('');
          if (isAudioWorkflow) stopAudioProgress(false);

          const errMsg =
            data?.error || data?.raw?.data?.failedReason?.exception_message || data?.raw?.msg || '未知错误';

          updateHistoryItem(historyId, { status: 'failed', error: errMsg });
          toast.error(`生成失败：${errMsg}`);
          resolve('task_failed');
          return;
        }

        if (attempts >= maxAttempts) {
          clearInterval(interval);
          setIsLoading(false);
          setStatusText('');
          if (isAudioWorkflow) stopAudioProgress(false);
          updateHistoryItem(historyId, {
            status: 'timeout',
            error: '生成超时，请稍后重试',
          });
          toast.error('生成超时，请稍后重试');
          resolve('task_timeout');
        }
      } catch {
        if (attempts >= maxAttempts) {
          clearInterval(interval);
          setIsLoading(false);
          setStatusText('');
          if (isAudioWorkflow) stopAudioProgress(false);
          updateHistoryItem(historyId, {
            status: 'timeout',
            error: '网络异常，查询超时',
          });
          toast.error('网络异常，查询超时');
          resolve('task_timeout');
        }
      }
      }, 2000);
    });
  };

  const hideHistoryRecords = async (input: { ids?: string[]; deleteAll?: boolean }) => {
    const response = await fetch('/api/me/tasks', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data?.success) {
      throw new Error(data?.message || '删除历史记录失败');
    }
    return Number(data?.data?.hidden || 0);
  };

  const clearHistory = () => {
    void (async () => {
      try {
        const hidden = await hideHistoryRecords({ deleteAll: true });
        setHistory([]);
        setSelectedHistoryIds([]);
        if (typeof window !== 'undefined') window.localStorage.removeItem(HISTORY_KEY);
        toast.success(`已清空 ${hidden} 条历史记录`);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : '删除历史记录失败';
        toast.error(message);
      }
    })();
  };

  const resetHistoryFilters = () => {
    setHistoryRecordFilter('all');
  };

  const clearResultPreview = () => {
    setResultMedia(null);
    setResultMediaHistoryId('');
  };

  const workflowTags = useMemo(() => {
    const set = new Set<string>();
    workflows.forEach((wf) => set.add(wf.category));
    return ['全部', ...Array.from(set)];
  }, []);

  const filteredWorkflows = useMemo(() => {
    const kw = workflowKeyword.trim().toLowerCase();
    return workflows.filter((wf) => {
      const tagOk = selectedWorkflowTag === '全部' || wf.category === selectedWorkflowTag;
      const kwOk =
        !kw ||
        wf.title.toLowerCase().includes(kw) ||
        wf.description.toLowerCase().includes(kw) ||
        wf.category.toLowerCase().includes(kw);
      return tagOk && kwOk;
    });
  }, [selectedWorkflowTag, workflowKeyword]);

  const rechargePackages = [
    { points: 1000, amount: 10, tag: '体验包' },
    { points: 5000, amount: 50, tag: '常用' },
    { points: 10000, amount: 100, tag: '推荐' },
    { points: 20000, amount: 200, tag: '企业' },
  ];

  const doRecharge = (points: number, amount: number) => {
    void (async () => {
      try {
        const createOrderRes = await fetch('/api/pay/orders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            channel: paymentMethod,
            amountFen: amount * 100,
            points,
            clientOrderNo: `CLIENT_${Date.now()}`,
          }),
        });
        const createOrderData = await createOrderRes.json().catch(() => ({}));
        if (!createOrderRes.ok || !createOrderData?.success) {
          toast.error(createOrderData?.message || '创建订单失败，请稍后重试');
          return;
        }

        const orderNo = String(createOrderData?.data?.orderNo || '');
        if (!orderNo) {
          toast.error('订单创建失败（缺少订单号）');
          return;
        }

        const mockPayRes = await fetch('/api/pay/mock/mark-paid', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderNo }),
        });
        const mockPayData = await mockPayRes.json().catch(() => ({}));
        if (!mockPayRes.ok || !mockPayData?.success) {
          toast.error(mockPayData?.message || '支付回调模拟失败');
          return;
        }

        const meRes = await fetch('/api/me', { cache: 'no-store' });
        const meData = await meRes.json().catch(() => ({}));
        if (!meRes.ok || !meData?.success) {
          toast.error('充值成功但刷新积分失败，请稍后刷新页面');
          return;
        }

        setAuthUser(meData.data);
        setBalance(Number(meData?.data?.points ?? balance + points));
        setRechargeRecords((prev) => [
          {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            points,
            amount,
            createdAt: Date.now(),
          },
          ...prev,
        ]);
        addPointLedgerItem({
          type: 'income',
          points,
          reason: `充值到账 ¥${amount}`,
        });
        toast.success(`充值成功 +${points} 积分`);
      } catch {
        toast.error('充值入账失败，请稍后重试');
      }
    })();
  };

  const handleRechargeSubmit = () => {
    let amount: number | null = null;

    if (selectedRechargeAmount !== null) {
      amount = selectedRechargeAmount;
    } else {
      const raw = customRechargeAmount.trim();
      if (!/^\d+$/.test(raw)) {
        toast.error('请输入10-100000的整数金额');
        return;
      }

      amount = Number(raw);
      if (!Number.isInteger(amount) || amount < 10 || amount > 100000) {
        toast.error('单次充值金额需为10到100000元的整数');
        return;
      }
    }

    setPendingRechargeAmount(amount);
    setPaymentMethod('wechat');
    setShowPaymentModal(true);
  };

  const handlePaymentSuccess = () => {
    if (pendingRechargeAmount === null) return;

    doRecharge(pendingRechargeAmount * 100, pendingRechargeAmount);
    setShowPaymentModal(false);
    setPendingRechargeAmount(null);
    setSelectedRechargeAmount(null);
    setCustomRechargeAmount('');
  };

  const removeHistoryItem = (id: string) => {
    void (async () => {
      try {
        await hideHistoryRecords({ ids: [id] });
        setHistory((prev) => prev.filter((item) => item.id !== id));
        setSelectedHistoryIds((prev) => prev.filter((itemId) => itemId !== id));
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : '删除历史记录失败';
        toast.error(message);
      }
    })();
  };

  const toggleHistorySelection = (id: string) => {
    setSelectedHistoryIds((prev) =>
      prev.includes(id) ? prev.filter((itemId) => itemId !== id) : [...prev, id]
    );
  };

  const toggleSelectAllFilteredHistory = (ids: string[]) => {
    if (ids.length === 0) return;
    setSelectedHistoryIds((prev) => {
      const allSelected = ids.every((id) => prev.includes(id));
      if (allSelected) return prev.filter((id) => !ids.includes(id));
      const merged = new Set([...prev, ...ids]);
      return Array.from(merged);
    });
  };

  const removeSelectedHistoryItems = () => {
    if (selectedHistoryIds.length === 0) {
      toast.error('请先选择要删除的记录');
      return;
    }

    const ids = [...selectedHistoryIds];
    void (async () => {
      try {
        const hidden = await hideHistoryRecords({ ids });
        setHistory((prev) => prev.filter((item) => !ids.includes(item.id)));
        toast.success(`已删除 ${hidden} 条记录`);
        setSelectedHistoryIds([]);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : '批量删除失败';
        toast.error(message);
      }
    })();
  };

  const exportAllHistoryAsZip = async () => {
    const exportItems = history.filter((item) => isTerminalHistoryStatus(item.status));
    if (exportItems.length === 0) {
      toast.error('暂无可导出的历史记录');
      return;
    }

    setExportingHistory(true);
    try {
      const encoder = new TextEncoder();
      const entries: Array<{ name: string; data: Uint8Array }> = [];
      const mediaFetchErrors: string[] = [];

      const historyJson = JSON.stringify(exportItems, null, 2);
      entries.push({ name: 'history.json', data: encoder.encode(historyJson) });

      const promptsText = exportItems
        .map((item, index) => {
          const textPayload = item.retryPayload?.inputs
            ? Object.values(item.retryPayload.inputs)
                .filter((v) => typeof v === 'string')
                .join(' | ')
            : '';
          return `${index + 1}. [${formatTime(item.createdAt)}] ${item.workflowTitle} | ${item.status} | requestId=${item.requestId}${textPayload ? ` | ${textPayload}` : ''}`;
        })
        .join('\n');
      entries.push({ name: 'prompts.txt', data: encoder.encode(promptsText || 'No prompts available') });

      let mediaIndex = 1;
      for (const item of exportItems) {
        if (!item.resultUrl) continue;
        try {
          const response = await fetch(item.resultUrl);
          if (!response.ok) throw new Error(String(response.status));
          const buffer = await response.arrayBuffer();
          const ext = inferFileExt(item.resultUrl, item.resultType === 'video' ? 'mp4' : item.resultType === 'audio' ? 'mp3' : 'jpg');
          const safeName = item.workflowTitle.replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
          entries.push({
            name: `media/${String(mediaIndex).padStart(3, '0')}-${safeName}.${ext}`,
            data: new Uint8Array(buffer),
          });
          mediaIndex += 1;
        } catch {
          mediaFetchErrors.push(item.resultUrl);
        }
      }

      if (mediaFetchErrors.length > 0) {
        entries.push({
          name: 'media_fetch_failed_urls.txt',
          data: encoder.encode(mediaFetchErrors.join('\n')),
        });
      }

      const zipBlob = createZipBlob(entries);
      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `dundun-history-${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      toast.success('历史记录导出完成');
    } catch {
      toast.error('导出失败，请稍后重试');
    } finally {
      setExportingHistory(false);
    }
  };

  const openPreview = (media: ResultMedia) => {
    setPreviewZoom(1);
    setPreviewOffset({ x: 0, y: 0 });
    setIsDraggingPreview(false);
    setImageLightboxOpen(false);
    setPreviewMedia(media);
  };

  const closePreview = () => {
    setPreviewMedia(null);
    setImageLightboxOpen(false);
    setPreviewZoom(1);
    setPreviewOffset({ x: 0, y: 0 });
    setIsDraggingPreview(false);
  };

  const openImageLightbox = () => {
    if (previewMedia?.type !== 'image') return;
    setPreviewZoom(1);
    setPreviewOffset({ x: 0, y: 0 });
    setIsDraggingPreview(false);
    setImageLightboxOpen(true);
  };

  const clampZoom = (z: number) => Math.max(0.5, Math.min(4, Number(z.toFixed(2))));

  const handlePreviewWheel = (e: ReactWheelEvent<HTMLDivElement>) => {
    if (previewMedia?.type !== 'image') return;
    e.preventDefault();

    const delta = e.deltaY < 0 ? 0.12 : -0.12;
    setPreviewZoom((prev) => clampZoom(prev + delta));
  };

  const handlePreviewMouseDown = (e: ReactMouseEvent<HTMLImageElement>) => {
    if (previewMedia?.type !== 'image') return;
    if (previewZoom <= 1) return;
    e.preventDefault();
    setIsDraggingPreview(true);
    setDragStart({ x: e.clientX, y: e.clientY });
  };

  const handlePreviewMouseMove = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (!isDraggingPreview || previewMedia?.type !== 'image') return;
    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;
    setDragStart({ x: e.clientX, y: e.clientY });
    setPreviewOffset((prev) => ({ x: prev.x + dx, y: prev.y + dy }));
  };

  const stopPreviewDragging = () => {
    setIsDraggingPreview(false);
  };

  useEffect(() => {
    if (previewZoom <= 1) {
      setPreviewOffset({ x: 0, y: 0 });
    }
  }, [previewZoom]);

  useEffect(() => {
    if (!previewMedia) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (imageLightboxOpen) {
          setImageLightboxOpen(false);
          setPreviewZoom(1);
          setPreviewOffset({ x: 0, y: 0 });
          setIsDraggingPreview(false);
          return;
        }
        closePreview();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [previewMedia, imageLightboxOpen]);

  const closeWorkflowModal = () => {
    if (isLoading) {
      const ok = window.confirm('任务仍在生成中，返回主界面后任务会继续在后台运行，可在历史记录中查看结果。确认返回吗？');
      if (!ok) return;
      toast.info('已返回主界面，任务继续在后台执行');
      if (audioProgressTimerRef.current) {
        clearInterval(audioProgressTimerRef.current);
        audioProgressTimerRef.current = null;
      }
    }

    setSelectedWorkflow(null);
    setFormData({});
    setAudioFile(null);
    setStatusText('');
    setAudioProgress(0);
  };

  const filteredHistory = useMemo(() => {
    const historyWithoutQueue = history.filter((item) => isTerminalHistoryStatus(item.status));

    return historyWithoutQueue.filter((item) => {
      let recordOk = true;
      if (historyRecordFilter === 'success') {
        recordOk = item.status === 'success';
      } else if (historyRecordFilter === 'failed') {
        recordOk = item.status === 'failed' || item.status === 'timeout' || item.status === 'cancelled';
      } else if (historyRecordFilter === 'image') {
        recordOk = item.resultType === 'image';
      } else if (historyRecordFilter === 'video') {
        recordOk = item.resultType === 'video';
      } else if (historyRecordFilter === 'audio') {
        recordOk = item.resultType === 'audio';
      }

      return recordOk;
    }).sort((a, b) => b.createdAt - a.createdAt);
  }, [history, historyRecordFilter]);

  const historyVisibleCount = useMemo(
    () => history.filter((item) => isTerminalHistoryStatus(item.status)).length,
    [history]
  );

  const filteredHistoryIds = useMemo(() => filteredHistory.map((item) => item.id), [filteredHistory]);
  const allFilteredSelected =
    filteredHistoryIds.length > 0 && filteredHistoryIds.every((id) => selectedHistoryIds.includes(id));

  const getQueuedPosition = (queueId: string) => {
    const queuedOnly = taskQueue.filter((t) => t.state === 'queued');
    const idx = queuedOnly.findIndex((t) => t.id === queueId);
    return idx >= 0 ? idx + 1 : null;
  };

  const focusRingClass =
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/80 focus-visible:ring-offset-1 focus-visible:ring-offset-white';

  const enqueueFromDetail = async (payload: RetryPayload, times: number) => {
    if (!payload || !payload.workflowId) return;

    const safeTimes = Math.max(1, Math.min(10, Number(times) || 1));
    const newTasks: QueueTask[] = [];
    const now = Date.now();

    for (let i = 0; i < safeTimes; i++) {
      const requestId = createRequestId();
      newTasks.push({
        id: `${now}-${Math.random().toString(36).slice(2, 8)}-ext-${i}`,
        requestId,
        historyId: null,
        payload: { ...payload, requestId },
        createdAt: now + i,
        state: 'queued',
        submittedTaskId: null,
      });
    }

    setTaskQueue((prev) => [...prev, ...newTasks]);
    toast.success(`已入队 ${safeTimes} 个任务，可在工作流中心查看`);
  };

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = async (event: Event) => {
      const custom = event as CustomEvent<{ payload: RetryPayload; times: number }>;
      if (!custom.detail?.payload) return;
      await enqueueFromDetail(custom.detail.payload, custom.detail.times);
    };

    window.addEventListener('dundun-enqueue-task', handler as EventListener);
    return () => window.removeEventListener('dundun-enqueue-task', handler as EventListener);
  }, []);

  const totalTaskCount = taskQueue.length;
  const isAdmin = authUser?.role === 'admin';

  const currentUserName = authUser?.username ?? '';
  const submitAuth = async () => {
    setAuthError('');

    const account = authAccount.trim();
    const password = authPassword;

    if (!ACCOUNT_RE.test(account)) {
      setAuthError('账号必须是10位纯数字');
      return;
    }
    if (!PASSWORD_RE.test(password)) {
      setAuthError('密码必须8-10位，且包含字母和数字');
      return;
    }
    if (authMode === 'register' && password !== authPasswordConfirm) {
      setAuthError('两次输入的密码不一致');
      return;
    }

    setAuthSubmitting(true);
    try {
      const path = authMode === 'register' ? '/api/auth/register' : '/api/auth/login-password';
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account, password }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        setAuthError(data.message || '操作失败');
        return;
      }

      setAuthUser(data.data);
      setSessionExpiredNotice('');
      setAuthAccount('');
      setAuthPassword('');
      setAuthPasswordConfirm('');
      setIsUserMenuOpen(false);
      setRechargeTab('user');
      toast.success(authMode === 'register' ? '注册并登录成功' : '登录成功');
    } catch {
      setAuthError('网络异常，请稍后重试');
    } finally {
      setAuthSubmitting(false);
    }
  };

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      setAuthUser(null);
      setAuthMode('login');
      setAuthAccount('');
      setAuthPassword('');
      setAuthPasswordConfirm('');
      setAuthError('');
      setIsUserMenuOpen(false);
      setShowAvatarModal(false);
      setShowUsernameModal(false);
      setShowPasswordModal(false);
      setRechargeTab('user');
      toast.success('已退出登录');
    }
  };

  const openUsernameModal = () => {
    setProfileUsername(authUser?.username ?? '');
    setShowUsernameModal(true);
  };

  const openAvatarModal = () => {
    const mode = authUser?.avatarType === 'upload' ? 'upload' : 'default';
    const value = String(authUser?.avatarValue || '');
    setAvatarMode(mode);
    if (mode === 'default') {
      const key = (DEFAULT_AVATAR_OPTIONS.some((item) => item.key === value) ? value : 'ocean') as DefaultAvatarKey;
      setAvatarDefaultKey(key);
      setAvatarUploadDataUrl('');
    } else {
      setAvatarUploadDataUrl(value || '');
      setAvatarDefaultKey('ocean');
    }
    setShowAvatarModal(true);
  };

  const openPasswordModal = () => {
    setPasswordCurrent('');
    setPasswordNext('');
    setPasswordConfirm('');
    setShowPasswordModal(true);
  };

  const onAvatarFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast.error('仅支持图片文件');
      return;
    }
    if (file.size > 1024 * 1024) {
      toast.error('图片请控制在 1MB 以内');
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      setAvatarUploadDataUrl(String(reader.result || ''));
      setAvatarMode('upload');
    };
    reader.onerror = () => {
      toast.error('读取图片失败，请重试');
    };
    reader.readAsDataURL(file);
  };

  const saveAvatar = async () => {
    if (!authUser) return;

    const value = avatarMode === 'default'
      ? (DEFAULT_AVATAR_OPTIONS.some((item) => item.key === avatarDefaultKey) ? avatarDefaultKey : 'ocean')
      : avatarUploadDataUrl;
    if (avatarMode === 'upload' && !avatarUploadDataUrl) {
      toast.error('请先上传头像图片');
      return;
    }

    setAvatarSubmitting(true);
    try {
      const response = await fetch('/api/me/avatar', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: avatarMode, value }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.success) {
        if (response.status === 413) {
          toast.error('头像图片过大，请换一张更小的图片');
          return;
        }
        toast.error(data?.message || '头像保存失败');
        return;
      }
      setAuthUser(data.data);
      setShowAvatarModal(false);
      toast.success('头像已更新');
    } catch {
      toast.error('网络异常，请稍后重试');
    } finally {
      setAvatarSubmitting(false);
    }
  };

  const saveProfileUsername = async () => {
    if (!authUser) return;
    const username = profileUsername.trim();
    if (!username) {
      toast.error('用户名不能为空');
      return;
    }

    setProfileSubmitting(true);

    try {
      const response = await fetch('/api/me/username', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success) {
        toast.error(data.message || '修改失败');
        return;
      }

      setAuthUser(data.data);
      setShowUsernameModal(false);
      toast.success('用户名已更新');
    } catch {
      toast.error('网络异常，请稍后重试');
    } finally {
      setProfileSubmitting(false);
    }
  };

  const savePassword = async () => {
    if (!authUser) return;
    if (!passwordCurrent) {
      toast.error('请输入当前密码');
      return;
    }
    if (!PASSWORD_RE.test(passwordNext)) {
      toast.error('新密码必须8-10位，且包含字母和数字');
      return;
    }
    if (passwordNext !== passwordConfirm) {
      toast.error('两次新密码输入不一致');
      return;
    }

    setPasswordSubmitting(true);
    try {
      const response = await fetch('/api/me/password', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: passwordCurrent, newPassword: passwordNext }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success) {
        toast.error(data.message || '修改密码失败');
        return;
      }

      setPasswordCurrent('');
      setPasswordNext('');
      setPasswordConfirm('');
      setShowPasswordModal(false);
      toast.success('密码已更新');
    } catch {
      toast.error('网络异常，请稍后重试');
    } finally {
      setPasswordSubmitting(false);
    }
  };

  const usageRowsInProfile = useMemo(() => {
    return pointLedger.map((row) => ({
      id: row.id,
      time: formatTime(row.createdAt),
      purpose: row.reason,
      statusLabel: row.type === 'income' ? '入账' : '扣减',
      statusClass: row.type === 'income' ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700',
      change: `${row.type === 'income' ? '+' : '-'}${row.points}`,
      changeClass: row.type === 'income' ? 'text-emerald-600' : 'text-rose-600',
    }));
  }, [pointLedger]);

  if (authLoading) {
    return (
      <div className="min-h-screen bg-[#f4f6fb] flex items-center justify-center text-zinc-600">
        正在加载登录状态...
      </div>
    );
  }

  if (!authUser) {
    return (
      <div className="min-h-screen bg-[#f4f6fb] flex items-center justify-center p-4">
        <Toaster position="top-center" richColors />
        <div className="w-full max-w-md bg-white border border-zinc-200 rounded-2xl p-6 shadow-xl">
          <h1 className="text-2xl font-bold text-zinc-900 mb-1">吨吨AI Pro</h1>
          <p className="text-sm text-zinc-500 mb-6">请先登录后继续使用工作流</p>

          {sessionExpiredNotice ? (
            <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
              {sessionExpiredNotice}
            </div>
          ) : null}

          <div className="inline-flex bg-zinc-100 rounded-xl p-1 mb-4 w-full">
            <button
              className={`flex-1 py-2 rounded-lg text-sm ${authMode === 'login' ? 'bg-zinc-900 text-white' : 'text-zinc-600'}`}
              onClick={() => {
                setAuthMode('login');
                setAuthError('');
              }}
            >
              登录
            </button>
            <button
              className={`flex-1 py-2 rounded-lg text-sm ${authMode === 'register' ? 'bg-zinc-900 text-white' : 'text-zinc-600'}`}
              onClick={() => {
                setAuthMode('register');
                setAuthError('');
              }}
            >
              注册
            </button>
          </div>

          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (authSubmitting) return;
              void submitAuth();
            }}
          >
            <div>
              <label className="block text-sm text-zinc-600 mb-1">账号</label>
              <input
                value={authAccount}
                onChange={(e) => setAuthAccount(e.target.value.replace(/\D/g, '').slice(0, 10))}
                placeholder="请输入10位数字账号"
                className="w-full bg-white border border-zinc-300 rounded-xl px-3 py-2 text-zinc-800"
              />
            </div>
            <div>
              <label className="block text-sm text-zinc-600 mb-1">密码</label>
              <input
                type="password"
                value={authPassword}
                onChange={(e) => setAuthPassword(e.target.value)}
                placeholder="8-10位，字母+数字组合"
                className="w-full bg-white border border-zinc-300 rounded-xl px-3 py-2 text-zinc-800"
              />
            </div>
            {authMode === 'register' && (
              <div>
                <label className="block text-sm text-zinc-600 mb-1">确认密码</label>
                <input
                  type="password"
                  value={authPasswordConfirm}
                  onChange={(e) => setAuthPasswordConfirm(e.target.value)}
                  placeholder="请再次输入密码"
                  className="w-full bg-white border border-zinc-300 rounded-xl px-3 py-2 text-zinc-800"
                />
              </div>
            )}
            {authError ? <p className="text-sm text-rose-500 mt-1">{authError}</p> : null}

            <button
              type="submit"
              disabled={authSubmitting}
              className="mt-4 w-full py-2.5 rounded-xl bg-zinc-900 text-white hover:bg-zinc-800 disabled:opacity-60"
            >
              {authSubmitting ? '提交中...' : authMode === 'register' ? '注册并登录' : '登录'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  const renderQueuePanel = () => (
    <div className="mb-4 bg-white border border-zinc-200 rounded-2xl p-4">
      <div className="flex items-center justify-between mb-2">
        <button
          onClick={() => setQueuePanelExpanded((v) => !v)}
          className="inline-flex items-center gap-2 text-sm text-zinc-700 hover:text-[#266eff]"
        >
          <span>任务队列</span>
          <span className="text-xs text-zinc-500">{taskQueue.length}</span>
          {queuePanelExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        <div className="flex items-center gap-2">
          <div className="text-xs text-zinc-500">等待中：{taskQueue.filter((t) => t.state === 'queued').length}</div>
        </div>
      </div>

      {queuePausedReason ? (
        <div className="mb-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2">
          <div className="text-xs text-rose-700">{queuePauseMessage(queuePausedReason)}</div>
        </div>
      ) : null}

      {!queuePanelExpanded ? (
        <div className="text-xs text-zinc-500">点击展开查看任务明细</div>
      ) : taskQueue.length === 0 ? (
        <div className="text-xs text-zinc-500">暂无排队任务</div>
      ) : (
        <div className="space-y-2">
          {taskQueue.map((q) => (
            <div
              key={q.id}
              className="flex items-center justify-between bg-zinc-50 border border-zinc-200 rounded-lg px-3 py-2"
            >
              <div className="min-w-0">
                <div className="text-sm text-zinc-800 line-clamp-1">{q.payload.workflowTitle}</div>
                <div className="text-xs text-zinc-500">
                  {q.state === 'running' ? '执行中' : `排队中 · 位置 ${getQueuedPosition(q.id) ?? '-'}`}
                </div>
              </div>

              {q.state === 'queued' ? (
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => moveQueuedTaskUpOne(q.id)}
                    className={`inline-flex items-center gap-1 text-xs text-zinc-700 px-2 py-1 rounded-lg border border-zinc-300 bg-white hover:bg-[#eef3ff] hover:text-[#266eff] ${focusRingClass}`}
                  >
                    <ArrowBigUp className="w-3.5 h-3.5" />
                    上移
                  </button>
                  <button
                    onClick={() => moveQueuedTaskDownOne(q.id)}
                    className={`inline-flex items-center gap-1 text-xs text-zinc-700 px-2 py-1 rounded-lg border border-zinc-300 bg-white hover:bg-[#eef3ff] hover:text-[#266eff] ${focusRingClass}`}
                  >
                    <ArrowBigDown className="w-3.5 h-3.5" />
                    下移
                  </button>
                  <button
                    onClick={() => promoteQueuedTask(q.id)}
                    className={`inline-flex items-center gap-1 text-xs text-zinc-700 px-2 py-1 rounded-lg border border-zinc-300 bg-white hover:bg-[#eef3ff] hover:text-[#266eff] ${focusRingClass}`}
                  >
                    <ArrowUp className="w-3.5 h-3.5" />
                    置顶
                  </button>
                  <button
                    onClick={() => demoteQueuedTask(q.id)}
                    className={`inline-flex items-center gap-1 text-xs text-zinc-700 px-2 py-1 rounded-lg border border-zinc-300 bg-white hover:bg-[#eef3ff] hover:text-[#266eff] ${focusRingClass}`}
                  >
                    <ArrowDown className="w-3.5 h-3.5" />
                    置底
                  </button>
                  <button
                    onClick={() => cancelQueuedTask(q.id)}
                    className={`text-xs text-zinc-700 px-2 py-1 rounded-lg border border-zinc-300 bg-white hover:bg-[#fff1f1] hover:text-rose-600 ${focusRingClass}`}
                  >
                    取消
                  </button>
                </div>
              ) : (
                <span className="text-xs text-violet-500">处理中</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div className="min-h-screen bg-[#f4f6fb] text-white flex">
      <Toaster position="top-center" richColors />

      {/* 左侧边栏 */}
      <div className="w-72 bg-white border-r border-zinc-200 p-6 flex flex-col text-zinc-800">
        <div className="flex items-center gap-3 mb-10">
          <img src="/kunkun-logo.png" alt="坤坤 AI Logo" className="w-9 h-9 rounded-2xl object-cover" />
          <div>
            <div className="font-bold text-2xl text-zinc-900">坤坤 AI</div>
            <div className="text-xs text-zinc-500">创作平台</div>
          </div>
        </div>

        <div className="space-y-1 flex-1">
          <button
            onClick={() => setActiveView('workflows')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl ${
              activeView === 'workflows'
                ? 'bg-gradient-to-r from-[#dde9ff] to-[#f9efff] text-[#266eff] font-medium'
                : 'text-zinc-600 hover:bg-[#f0f3f7] hover:text-zinc-800'
            }`}
          >
            <Home className="w-5 h-5" />
            <span className="font-medium">工作流中心</span>
          </button>

          <button
            onClick={() => setActiveView('recharge')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl ${
              activeView === 'recharge'
                ? 'bg-gradient-to-r from-[#dde9ff] to-[#f9efff] text-[#266eff] font-medium'
                : 'text-zinc-600 hover:bg-[#f0f3f7] hover:text-zinc-800'
            }`}
          >
            <Wallet className="w-5 h-5" />
            <span>充值</span>
          </button>

          <button
            onClick={() => setActiveView('history')}
            className={`w-full flex items-center justify-between px-4 py-3 rounded-xl ${
              activeView === 'history'
                ? 'bg-gradient-to-r from-[#dde9ff] to-[#f9efff] text-[#266eff] font-medium'
                : 'text-zinc-600 hover:bg-[#f0f3f7] hover:text-zinc-800'
            }`}
          >
            <span className="flex items-center gap-3">
              <Clock className="w-5 h-5" />
              <span>历史记录</span>
            </span>
          </button>
        </div>

      </div>

      {/* 主内容 */}
      <div className="flex-1 overflow-auto">
        <div className="bg-white border-b border-zinc-200 px-4 sm:px-6 lg:px-8 xl:px-10 py-3">
          <div className="flex items-center justify-between">
            <div className="text-sm text-zinc-600">📢 通知：平台功能持续升级中，如遇问题请联系顾问</div>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1 text-sm text-zinc-600 bg-zinc-100 rounded-full px-3 py-1">
                <span>💰</span>
                <span>{balance}</span>
              </div>
              {totalTaskCount > 0 && (
                <div className="flex items-center gap-1 text-sm text-violet-700 bg-violet-50 rounded-full px-3 py-1 border border-violet-200">
                  <span>⏳ 任务进行中</span>
                  <span className="font-semibold">{totalTaskCount}</span>
                </div>
              )}
              <div ref={userMenuRef} className="relative">
                <button
                  onClick={() => setIsUserMenuOpen((value) => !value)}
                  className="flex items-center gap-1 text-sm text-zinc-700 bg-zinc-100 rounded-full px-3 py-1"
                >
                  {renderUserAvatar('w-5 h-5')}
                  {currentUserName}
                </button>
                <div
                  className={`absolute right-0 mt-2 bg-white border border-zinc-200 rounded-xl shadow-xl p-2 min-w-36 z-20 ${
                    isUserMenuOpen ? 'block' : 'hidden'
                  }`}
                >
                  <div className="px-3 py-1 text-xs text-zinc-700">账号：{authUser.account}</div>
                  <button
                    onClick={() => {
                      setActiveView('recharge');
                      setRechargeTab('user');
                      setIsUserMenuOpen(false);
                    }}
                    className="w-full text-left px-3 py-2 text-sm text-zinc-900 rounded-lg hover:bg-zinc-100"
                  >
                    个人中心
                  </button>
                  {isAdmin ? (
                    <Link
                      href="/admin"
                      onClick={() => setIsUserMenuOpen(false)}
                      className="block w-full text-left px-3 py-2 text-sm text-zinc-900 rounded-lg hover:bg-zinc-100"
                    >
                      管理后台
                    </Link>
                  ) : null}
                  <button
                    onClick={handleLogout}
                    className="w-full text-left px-3 py-2 text-sm text-zinc-900 rounded-lg hover:bg-zinc-100"
                  >
                    退出
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="max-w-[1720px] mx-auto px-4 sm:px-6 lg:px-8 xl:px-10 py-8 lg:py-10">
          {activeView === 'workflows' ? (
            <>
              <h1 className="text-4xl lg:text-[2.5rem] font-bold mb-3 text-zinc-900">打造真正能卖货的视觉内容</h1>
              <p className="text-base lg:text-lg text-zinc-400 mb-10">产品图、广告视频、品牌内容，通过专业工作流快速交付</p>

              <div className="bg-white border border-zinc-200 rounded-xl p-4 mb-6">
                <div className="flex flex-col lg:flex-row gap-3 lg:items-center lg:justify-between">
                  <div className="flex flex-wrap gap-2">
                    {workflowTags.map((tag) => {
                      const active = selectedWorkflowTag === tag;
                      return (
                        <button
                          key={tag}
                          onClick={() => setSelectedWorkflowTag(tag)}
                    className={`px-3 py-1.5 text-sm rounded-xl border transition-colors ${
                      active
                        ? 'bg-brand-gradient border-transparent text-white font-medium shadow-sm'
                        : 'border-zinc-200 text-zinc-600 hover:bg-[#f0f3f7] hover:text-[#266eff] hover:border-[#d7e3ff]'
                    }`}
                  >
                          {tag}
                        </button>
                      );
                    })}
                  </div>

                  <div className="relative w-full lg:w-72">
                    <Search className="w-4 h-4 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      value={workflowKeyword}
                      onChange={(e) => setWorkflowKeyword(e.target.value)}
                      placeholder="搜索工作流"
                      className="w-full bg-white border border-zinc-200 rounded-xl pl-9 pr-3 py-2 text-sm placeholder-zinc-500 text-zinc-700 no-focus-ring"
                    />
                  </div>
                </div>
              </div>

              {renderQueuePanel()}

              {workflowCenterLocked ? (
                <div className="mb-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                  <span>工作流中心已临时禁用：检测到“后台成功但前端未完成结果展示”的异常，请等待问题修复后再继续使用。</span>
                </div>
              ) : null}

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-5">
                {filteredWorkflows.map((wf) => (
                  <Link
                    key={wf.id}
                    href={`/workflow-app/${wf.slug}`}
                    onClick={(e) => {
                      if (workflowCenterLocked) {
                        e.preventDefault();
                        toast.error('当前已临时禁用全部 AI 应用，请等待修复后再使用');
                        return;
                      }
                      setNavigatingSlug(wf.slug);
                    }}
                    className={`bg-[#7f1010] border border-[#6f0d0d] rounded-2xl p-4 transition-all duration-200 transform-gpu group text-white ${
                      workflowCenterLocked
                        ? 'opacity-50 cursor-not-allowed'
                        : 'hover:shadow-xl hover:scale-[1.02] cursor-pointer'
                    }`}
                  >
                    <div className="flex justify-between mb-3">
                      <div className="text-xs tracking-wide text-rose-100/80 uppercase">{wf.enTitle || 'Workflow'}</div>
                    </div>

                    <h3 className="font-bold text-xl mb-1 line-clamp-1">{wf.title}</h3>
                    <p className="text-rose-100/90 text-sm mb-3 line-clamp-2">{wf.description}</p>

                    <div className="rounded-xl overflow-hidden border border-white/10 mb-3 bg-white/10">
                      <img
                        src={wf.coverImage || 'https://dundun2026.oss-cn-guangzhou.aliyuncs.com/waterfalls/20260326_e8d3f4780d11.jpg'}
                        alt={wf.title}
                        className="w-full h-32 object-cover"
                        loading="lazy"
                      />
                    </div>

                    <div className="text-[11px] text-rose-100/80 mb-3">模型：Qwen / FLUX / Wan2.2 可用 · 支持高一致性输出</div>
                  </Link>
                ))}
              </div>

              {filteredWorkflows.length === 0 && (
                <div className="mt-6 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-8 text-center text-zinc-400">
                  没有找到匹配的工作流，试试更换标签或关键词。
                </div>
              )}
            </>
          ) : activeView === 'recharge' ? (
            <>
              <div className="text-center mb-6">
                <h1 className="text-4xl font-semibold text-zinc-800 mb-2">账户设置</h1>
                <p className="text-zinc-500">管理您的账户信息、订阅支付</p>
              </div>

              <div className="bg-white rounded-3xl p-5 shadow-sm border border-zinc-200">
                <div className="bg-[#f5f7fa] rounded-3xl p-5 flex flex-col lg:flex-row gap-5 min-h-[720px]">
                  <div className="bg-white rounded-2xl w-full lg:w-[280px] p-3 flex lg:flex-col gap-2">
                    <button
                      onClick={() => setRechargeTab('user')}
                      className={`h-11 px-4 rounded-xl text-sm ${
                        rechargeTab === 'user'
                          ? 'bg-gradient-to-r from-[#dde9ff] to-[#f9efff] text-[#266eff] font-medium'
                          : 'text-zinc-600 hover:bg-zinc-100'
                      }`}
                    >
                      用户
                    </button>
                    <button
                      onClick={() => setRechargeTab('points')}
                      className={`h-11 px-4 rounded-xl text-sm ${
                        rechargeTab === 'points'
                          ? 'bg-gradient-to-r from-[#dde9ff] to-[#f9efff] text-[#266eff] font-medium'
                          : 'text-zinc-600 hover:bg-zinc-100'
                      }`}
                    >
                      购买更多积分
                    </button>
                    <button
                      onClick={() => setRechargeTab('referral')}
                      className={`h-11 px-4 rounded-xl text-sm ${
                        rechargeTab === 'referral'
                          ? 'bg-gradient-to-r from-[#dde9ff] to-[#f9efff] text-[#266eff] font-medium'
                          : 'text-zinc-600 hover:bg-zinc-100'
                      }`}
                    >
                      推广计划
                    </button>
                    <div className="hidden lg:block my-1 h-px bg-zinc-200" />
                    <button
                      onClick={() => setRechargeTab('help')}
                      className={`h-11 px-4 rounded-xl text-sm ${
                        rechargeTab === 'help'
                          ? 'bg-gradient-to-r from-[#dde9ff] to-[#f9efff] text-[#266eff] font-medium'
                          : 'text-zinc-600 hover:bg-zinc-100'
                      }`}
                    >
                      帮助与反馈
                    </button>
                  </div>

                  <div className="flex-1 min-w-0">
                    {rechargeTab === 'user' && (
                      <div className="space-y-5">
                        <div className="bg-white rounded-2xl p-7">
                          <div className="text-base font-semibold text-zinc-800 mb-5 border-l-4 border-[#266eff] pl-3">个人资料</div>
                          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-5">
                            <div className="flex items-center gap-4">
                              <button
                                type="button"
                                onClick={openAvatarModal}
                                className="rounded-full hover:brightness-95 transition"
                                title="点击更换头像"
                              >
                                {renderUserAvatar('w-14 h-14')}
                              </button>
                              <div>
                                <div className="text-2xl font-semibold text-zinc-800">{currentUserName}</div>
                                <div className="text-sm text-zinc-500">UID：{authUser.id.slice(-6)}</div>
                              </div>
                            </div>
                            <div className="flex flex-wrap gap-3">
                              <button
                                onClick={openUsernameModal}
                                className="h-11 px-5 rounded-xl bg-gradient-to-r from-[#dde9ff] to-[#f9efff] text-[#266eff] font-medium"
                              >
                                修改用户名
                              </button>
                              <button
                                onClick={openPasswordModal}
                                className="h-11 px-5 rounded-xl bg-gradient-to-r from-[#dde9ff] to-[#f9efff] text-[#266eff] font-medium"
                              >
                                修改密码
                              </button>
                              <button
                                onClick={handleLogout}
                                className="h-11 px-5 rounded-xl bg-gradient-to-r from-[#dde9ff] to-[#f9efff] text-[#266eff] font-medium"
                              >
                                退出登录
                              </button>
                            </div>
                          </div>

                          <div className="h-px bg-zinc-200 my-5" />

                          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                            <div className="rounded-2xl bg-[#f5f7fa] border border-zinc-200 px-4 py-3 inline-flex items-center gap-3">
                              <span className="text-zinc-700 text-lg font-semibold">可用积分</span>
                              <span className="text-2xl font-semibold text-zinc-800">{balance}</span>
                            </div>
                            <button
                              onClick={() => setRechargeTab('points')}
                              className="h-11 px-6 rounded-xl btn-brand-gradient"
                            >
                              购买更多积分
                            </button>
                          </div>

                        </div>

                        <div className="bg-white rounded-2xl p-7">
                          <div className="text-base font-semibold text-zinc-800 mb-5 border-l-4 border-[#266eff] pl-3">使用情况</div>
                          <div className="overflow-x-auto">
                            <table className="w-full text-center text-sm">
                              <thead>
                                <tr className="border-b border-zinc-200 text-zinc-600">
                                  <th className="pb-3 font-semibold">时间</th>
                                  <th className="pb-3 font-semibold">用途</th>
                                  <th className="pb-3 font-semibold">状态</th>
                                  <th className="pb-3 font-semibold">积分变更</th>
                                </tr>
                              </thead>
                              <tbody>
                                {usageRowsInProfile.length === 0 ? (
                                  <tr>
                                    <td colSpan={4} className="py-8 text-zinc-400">
                                      暂无记录
                                    </td>
                                  </tr>
                                ) : (
                                  (showAllUsageInProfile ? usageRowsInProfile : usageRowsInProfile.slice(0, 8)).map((row) => (
                                    <tr key={row.id} className="border-b border-zinc-100">
                                      <td className="py-3 text-zinc-600">{row.time}</td>
                                      <td className="py-3 text-zinc-700" title={row.purpose}>
                                        <span className="inline-block max-w-[360px] truncate align-middle">{row.purpose}</span>
                                      </td>
                                      <td className="py-3">
                                        <span className={`px-2 py-1 text-xs rounded ${row.statusClass}`}>{row.statusLabel}</span>
                                      </td>
                                      <td className={`py-3 font-medium ${row.changeClass}`}>{row.change}</td>
                                    </tr>
                                  ))
                                )}
                              </tbody>
                            </table>
                          </div>
                          {usageRowsInProfile.length > 8 && (
                            <div className="text-right mt-3">
                              <button
                                onClick={() => setShowAllUsageInProfile((v) => !v)}
                                className="text-xs text-zinc-500 hover:text-[#266eff]"
                              >
                                {showAllUsageInProfile ? '收起' : '查看更多'} ›
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    {rechargeTab === 'points' && (
                      <div className="space-y-5">
                        <div className="text-center mb-2">
                          <div className="text-3xl font-semibold text-zinc-800">订阅会员</div>
                          <div className="text-sm text-zinc-500 mt-2">基于产品特性，支付后不支持退款，请确认后购买。</div>
                        </div>

                        <div className="bg-white rounded-2xl p-7">
                          <div className="text-zinc-600 mb-4">
                            选择充值金额 <span className="text-xl font-semibold text-zinc-800">（1元 = 100积分）</span>
                          </div>
                          <div className="flex flex-wrap items-center gap-3 mb-4">
                            {rechargePackages.map((pkg) => (
                              <button
                                key={pkg.amount}
                                onClick={() => {
                                  setSelectedRechargeAmount(pkg.amount);
                                  setCustomRechargeAmount('');
                                }}
                                className={`h-12 px-6 rounded-full border text-sm transition-colors ${
                                  selectedRechargeAmount === pkg.amount
                                    ? 'bg-gradient-to-r from-[#dde9ff] to-[#f9efff] border-transparent text-[#266eff] font-medium'
                                    : 'bg-white border-zinc-200 text-zinc-700 hover:border-[#d7e3ff] hover:text-[#266eff]'
                                }`}
                              >
                                ¥{pkg.amount}
                              </button>
                            ))}

                            <div className="h-12 rounded-full border border-zinc-200 bg-white px-4 inline-flex items-center gap-2">
                              <span className="text-sm text-zinc-500">¥</span>
                              <input
                                value={customRechargeAmount}
                                onChange={(e) => {
                                  const value = e.target.value;
                                  if (!/^\d*$/.test(value)) return;
                                  setCustomRechargeAmount(value);
                                  setSelectedRechargeAmount(null);
                                }}
                                inputMode="numeric"
                                maxLength={6}
                                placeholder="自定义金额"
                                className="h-12 w-28 bg-transparent text-sm text-zinc-700 outline-none no-focus-ring"
                              />
                            </div>

                            <button
                              onClick={handleRechargeSubmit}
                              className="h-12 px-8 rounded-full bg-gradient-to-r from-[#dde9ff] to-[#f9efff] text-[#266eff] text-base font-semibold hover:brightness-95 transition"
                            >
                              充值
                            </button>
                          </div>
                          <div className="text-sm text-zinc-500">自定义金额仅支持10-100000元阿拉伯数字整数，点击“充值”后进入支付弹窗。</div>
                        </div>

                        <div className="bg-white rounded-2xl p-7">
                          <div className="text-base font-semibold text-zinc-800 mb-4 border-l-4 border-[#266eff] pl-3">充值记录</div>
                          {rechargeRecords.length === 0 ? (
                            <div className="py-8 text-center text-zinc-400">暂无充值记录</div>
                          ) : (
                            <div className="space-y-2">
                              {rechargeRecords.map((r) => (
                                <div
                                  key={r.id}
                                  className="flex items-center justify-between rounded-xl border border-zinc-200 bg-[#f8faff] px-4 py-3"
                                >
                                  <div className="text-zinc-700">充值金额：¥{r.amount}</div>
                                  <div className="text-zinc-700">获得积分：+{r.points}</div>
                                  <div className="text-zinc-500 text-xs">{formatTime(r.createdAt)}</div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    {rechargeTab === 'referral' && (
                      <div className="bg-white rounded-2xl p-7">
                        <div className="text-base font-semibold text-zinc-800 mb-4 border-l-4 border-[#266eff] pl-3">推广计划</div>
                        <div className="text-sm text-zinc-500">该功能暂未开放，敬请期待。</div>
                      </div>
                    )}

                    {rechargeTab === 'help' && (
                      <div className="bg-white rounded-2xl p-7">
                        <div className="text-base font-semibold text-zinc-800 mb-4 border-l-4 border-[#266eff] pl-3">帮助与反馈</div>
                        <p className="text-zinc-600">如需帮助，请点击右下角“专属顾问”联系人工支持。</p>
                        <div className="mt-4 rounded-xl border border-zinc-200 bg-[#f8faff] p-4 text-sm text-zinc-600 space-y-1">
                          <div className="font-medium text-zinc-700">隐私与保存期限说明</div>
                          <div>生成内容历史：默认保留15天。</div>
                          <div>积分消费记录：保留15天。</div>
                          <div>充值记录：保留1年。</div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center justify-between mb-6">
                <h1 className="text-3xl font-bold text-zinc-900">历史记录</h1>
                <div className="flex items-center gap-2">
                  <button
                    onClick={exportAllHistoryAsZip}
                    disabled={exportingHistory}
                    className="text-sm px-3 py-1.5 rounded-lg border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 disabled:opacity-60"
                  >
                    {exportingHistory ? '导出中...' : '一键导出ZIP'}
                  </button>
                  <button
                    onClick={removeSelectedHistoryItems}
                    disabled={selectedHistoryIds.length === 0}
                    className="text-sm px-3 py-1.5 rounded-lg border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 disabled:opacity-60"
                  >
                    批量删除
                  </button>
                  <button
                    onClick={clearHistory}
                    className="text-sm px-3 py-1.5 rounded-lg btn-brand-gradient"
                  >
                    清空记录
                  </button>
                </div>
              </div>

              <div className="text-xs text-zinc-500 mb-4">您的作品将在创建后保存15天，到期后系统将自动清理。</div>

              <div className="bg-white border border-zinc-200 rounded-xl p-4 mb-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="text-xs text-zinc-500">筛选条件</div>
                  <button
                    onClick={resetHistoryFilters}
                    className="text-xs px-3 py-1 rounded-lg btn-brand-gradient"
                  >
                    一键重置筛选
                  </button>
                </div>

                <div className="inline-flex flex-wrap gap-1 bg-zinc-100 border border-zinc-200 rounded-2xl p-1">
                  {[
                    { key: 'all', label: '全部' },
                    { key: 'success', label: '成功' },
                    { key: 'failed', label: '失败' },
                    { key: 'image', label: '图片' },
                    { key: 'video', label: '视频' },
                    { key: 'audio', label: '音频' },
                  ].map((f) => {
                    const active = historyRecordFilter === f.key;
                    return (
                      <button
                        key={f.key}
                        onClick={() =>
                          setHistoryRecordFilter(f.key as HistoryRecordFilter)
                        }
                        className={`px-3 py-1.5 text-sm rounded-xl transition-colors ${
                          active
                            ? 'bg-brand-gradient text-white shadow-sm border border-transparent'
                            : 'text-zinc-600 hover:bg-[#f0f3f7] hover:text-[#266eff]'
                        }`}
                      >
                        {f.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {historyVisibleCount === 0 ? (
                <div className="rounded-2xl border border-zinc-200 bg-white p-8 text-center">
                  <div className="mx-auto mb-3 w-12 h-12 rounded-2xl bg-[#f8faff] border border-zinc-200 flex items-center justify-center text-zinc-400">
                    <Inbox className="w-6 h-6" />
                  </div>
                  <p className="text-zinc-700 font-medium">暂无历史记录</p>
                  <p className="text-zinc-500 text-sm mt-1 mb-4">先去创建一个任务，结果会自动保存到这里。</p>
                  <button
                    onClick={() => setActiveView('workflows')}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-xl btn-brand-gradient"
                  >
                    <Sparkles className="w-4 h-4" />
                    去创建任务
                  </button>
                </div>
              ) : filteredHistory.length === 0 ? (
                <p className="text-zinc-400 text-sm">当前筛选条件下没有匹配记录。</p>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-center justify-between px-1 text-xs text-zinc-500">
                    <label className="inline-flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={allFilteredSelected}
                        onChange={() => toggleSelectAllFilteredHistory(filteredHistoryIds)}
                      />
                      全选当前筛选结果
                    </label>
                    <span>已选 {selectedHistoryIds.length} 条</span>
                  </div>
                  {filteredHistory.map((item) => {
                    const meta = statusMeta(item.status);
                    const media: ResultMedia | null = item.resultUrl
                      ? { url: item.resultUrl, type: item.resultType || inferMediaType(item.resultUrl) }
                      : null;

                    return (
                      <div
                        key={item.id}
                        className="rounded-2xl border border-zinc-200 p-4 bg-white"
                      >
                        <div className="flex flex-wrap gap-3 items-center justify-between">
                          <div>
                            <label className="inline-flex items-center gap-2 mb-1 text-xs text-zinc-500">
                              <input
                                type="checkbox"
                                checked={selectedHistoryIds.includes(item.id)}
                                onChange={() => toggleHistorySelection(item.id)}
                              />
                              选择
                            </label>
                            <div className="font-medium text-zinc-900">{item.workflowTitle}</div>
                            <div className="text-xs text-zinc-500 mt-1">{formatTime(item.createdAt)}</div>
                            <div className="text-xs text-zinc-500 mt-1">追踪ID：{item.requestId}</div>
                          </div>
                          <span className={`text-xs px-2.5 py-1 rounded-full ${meta.className}`}>{meta.label}</span>
                        </div>

                        {item.error && (
                          <div className="mt-3 text-sm text-rose-600">错误：{item.error}</div>
                        )}

                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          {media && (
                            <button
                              onClick={() => openPreview(media)}
                              className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-xl bg-[#f8faff] border border-zinc-200 hover:bg-[#f0f3f7] hover:text-[#266eff] hover:border-[#d7e3ff] text-zinc-700 transition-colors"
                            >
                              <Eye className="w-4 h-4" />
                              预览
                            </button>
                          )}

                          {media && (
                            <a
                              href={media.url}
                              download
                              className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-xl bg-[#f8faff] border border-zinc-200 hover:bg-[#f0f3f7] hover:text-[#266eff] hover:border-[#d7e3ff] text-zinc-700 transition-colors"
                            >
                              <Download className="w-4 h-4" />
                              下载
                            </a>
                          )}

                          {media && (
                            <button
                              onClick={() => removeHistoryItem(item.id)}
                              className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-xl border border-zinc-200 hover:bg-[#f0f3f7] hover:text-[#266eff] hover:border-[#d7e3ff] text-zinc-700 transition-colors"
                            >
                              <Trash2 className="w-4 h-4" />
                              删除
                            </button>
                          )}

                          {(item.status === 'failed' || item.status === 'timeout') && (
                            <button
                              onClick={() => retryHistoryItem(item)}
                              className="px-3 py-1.5 text-sm rounded-xl btn-brand-gradient"
                            >
                              一键重试同参数
                            </button>
                          )}

                          {!media && (
                            <button
                              onClick={() => removeHistoryItem(item.id)}
                              className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-xl border border-zinc-200 hover:bg-[#f0f3f7] hover:text-[#266eff] hover:border-[#d7e3ff] text-zinc-700 transition-colors"
                            >
                              <Trash2 className="w-4 h-4" />
                              删除
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* 工作流弹窗 */}
      {selectedWorkflow && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className="bg-zinc-900 rounded-2xl w-full max-w-lg p-7 max-h-[90vh] overflow-auto border border-zinc-800">
            <div className="flex items-start justify-between gap-3">
              <h2 className="text-2xl font-bold mb-2">{selectedWorkflow.title}</h2>
              <button
                onClick={closeWorkflowModal}
                className="p-2 rounded-xl hover:bg-zinc-800 text-zinc-400 hover:text-white"
                aria-label="关闭弹窗"
                title="关闭"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-zinc-400 mb-6">{selectedWorkflow.description}</p>

            <div className="space-y-6">
              {selectedWorkflow.inputs.map((input) => (
                <div key={input.key}>
                  <label className="block text-sm text-zinc-400 mb-2">{input.label}</label>

                  {input.type === 'text' && (
                    <textarea
                      value={String(formData[input.key] ?? '')}
                      onChange={(e) => handleInputChange(input.key, e.target.value)}
                      placeholder={input.placeholder}
                      className="w-full h-32 bg-zinc-800 border border-zinc-700 rounded-2xl p-4 text-white placeholder-zinc-500 focus:outline-none focus:border-violet-500"
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
                      className="w-full bg-zinc-800 border border-zinc-700 rounded-2xl p-4 text-white focus:outline-none focus:border-violet-500"
                    />
                  )}

                  {input.type === 'audio' && (
                    <div className="border-2 border-dashed border-zinc-700 rounded-2xl p-8 text-center">
                      <input
                        type="file"
                        accept="audio/*"
                        onChange={handleAudioUpload}
                        className="hidden"
                        id={`audio-${input.key}`}
                      />
                      <label htmlFor={`audio-${input.key}`} className="cursor-pointer block">
                        <div className="text-5xl mb-3">🎵</div>
                        <div className="text-violet-400">点击上传参考音频</div>
                        {audioFile && <p className="mt-2 text-sm text-zinc-400">{audioFile.name}</p>}
                      </label>
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div className="flex gap-3 mt-8">
              <button
                onClick={closeWorkflowModal}
                className="flex-1 py-3 border border-zinc-700 rounded-2xl hover:bg-zinc-800"
              >
                返回主界面
              </button>
              <button
                onClick={handleGenerate}
                disabled={isLoading}
                className="flex-1 py-3 bg-zinc-900 hover:bg-zinc-800 hover:ring-2 hover:ring-amber-300/70 border border-zinc-900 rounded-2xl font-medium text-white disabled:opacity-50 transition-all"
              >
                {isLoading ? '生成中...' : '开始生成'}
              </button>
            </div>

            {(isLoading || resultMedia) && <div className="mt-6 border-t border-zinc-800" />}

            {isLoading && (
              <div className="mt-4 bg-zinc-800/50 border border-zinc-700 rounded-xl p-3">
                {statusText && <div className="text-sm text-zinc-300">{statusText}</div>}

                {currentWorkflowIsAudio && (
                  <div className="mt-2">
                    <div className="flex items-center justify-between text-xs text-zinc-400 mb-1">
                      <span>音频处理中</span>
                      <span>{audioProgress}%</span>
                    </div>
                    <div className="h-2 rounded-full bg-zinc-800 overflow-hidden">
                      <div
                        className="h-full bg-violet-500 transition-all duration-700 ease-out"
                        style={{ width: `${audioProgress}%` }}
                      />
                    </div>
                  </div>
                )}
              </div>
            )}

            {resultMedia && (
              <div className="mt-6">
                {renderMediaPreview(resultMedia, undefined, {
                  onLoad: () => {
                    if (!resultMediaHistoryId) return;
                    const hit = history.find((item) => item.id === resultMediaHistoryId) || null;
                    if (!hit || !['pending', 'retrying', 'failed'].includes(String(hit.deliveryStatus || 'none'))) return;
                    reportDeliveryState(resultMediaHistoryId, 'ack');
                  },
                  onError: () => {
                    if (!resultMediaHistoryId) return;
                    reportDeliveryState(resultMediaHistoryId, 'fail', '前端结果预览加载失败');
                  },
                })}
                <div className="mt-4 flex gap-3">
                  <a
                    href={resultMedia.url}
                    download
                    className="flex-1 text-center py-3 bg-zinc-900 hover:bg-zinc-800 hover:ring-2 hover:ring-amber-300/70 border border-zinc-900 rounded-2xl text-white transition-all"
                  >
                    下载
                  </a>
                  <button
                    onClick={clearResultPreview}
                    className="flex-1 py-3 bg-zinc-900 hover:bg-zinc-800 hover:ring-2 hover:ring-amber-300/70 border border-zinc-900 rounded-2xl text-white transition-all"
                  >
                    确认
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 统一媒体预览弹窗（历史记录/结果复用） */}
      {previewMedia && (
        <div
          className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[60] flex items-center justify-center p-4"
          onClick={closePreview}
        >
          <div
            className={`w-full ${previewMedia.type === 'image' ? 'max-w-3xl' : 'max-w-4xl'} bg-white rounded-3xl border border-zinc-200 p-4 sm:p-6 max-h-[88vh] overflow-auto shadow-2xl`}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-4">
              <div className="text-sm text-zinc-500">媒体预览（点击空白处关闭）</div>
            </div>

            {previewMedia.type === 'image' ? (
              <button
                type="button"
                onClick={openImageLightbox}
                className="w-full rounded-2xl bg-zinc-100 border border-zinc-200 overflow-hidden"
              >
                <div className="max-h-[66vh] min-h-[260px] flex items-center justify-center p-2 sm:p-3">
                  <img
                    src={previewMedia.url}
                    alt="预览图片"
                    className="max-w-full max-h-[62vh] object-contain"
                  />
                </div>
              </button>
            ) : (
              renderMediaPreview(previewMedia, 'rounded-2xl w-full max-h-[66vh] object-contain bg-[#f5f7fb] border border-zinc-200')
            )}

            {previewMedia.type === 'image' ? (
              <div className="mt-4 text-xs text-zinc-500">点击图片进入灯箱预览（支持滚轮缩放、拖拽平移、ESC 关闭）</div>
            ) : null}
          </div>
        </div>
      )}

      {previewMedia?.type === 'image' && imageLightboxOpen && (
        <div
          className="fixed inset-0 z-[80] bg-black/85 flex items-center justify-center p-3"
          onClick={() => {
            setImageLightboxOpen(false);
            setPreviewZoom(1);
            setPreviewOffset({ x: 0, y: 0 });
            setIsDraggingPreview(false);
          }}
        >
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setImageLightboxOpen(false);
              setPreviewZoom(1);
              setPreviewOffset({ x: 0, y: 0 });
              setIsDraggingPreview(false);
            }}
            className="absolute top-4 right-4 z-[81] w-10 h-10 rounded-full bg-black/45 border border-white/30 text-white flex items-center justify-center hover:bg-black/65"
            aria-label="关闭灯箱预览"
            title="关闭"
          >
            <X className="w-5 h-5" />
          </button>

          <div
            ref={previewContainerRef}
            onClick={(event) => event.stopPropagation()}
            onWheel={handlePreviewWheel}
            onMouseMove={handlePreviewMouseMove}
            onMouseUp={stopPreviewDragging}
            onMouseLeave={stopPreviewDragging}
            className="w-full h-full max-w-[96vw] max-h-[96vh] flex items-center justify-center overflow-hidden select-none"
          >
            <img
              src={previewMedia.url}
              alt="灯箱预览"
              onMouseDown={handlePreviewMouseDown}
              style={{
                transform: `translate(${previewOffset.x}px, ${previewOffset.y}px) scale(${previewZoom})`,
                cursor: previewZoom > 1 ? (isDraggingPreview ? 'grabbing' : 'grab') : 'zoom-in',
              }}
              className="max-w-[94vw] max-h-[94vh] object-contain transition-transform duration-150"
            />
          </div>
        </div>
      )}

      {showPaymentModal && pendingRechargeAmount !== null && (
        <div className="fixed inset-0 bg-black/60 z-[72] flex items-center justify-center p-4" onClick={() => setShowPaymentModal(false)}>
          <div className="w-full max-w-md bg-white rounded-3xl p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between mb-4">
              <div>
                <h3 className="text-xl font-semibold text-zinc-900">支付界面</h3>
                <p className="text-sm text-zinc-500 mt-1">充值金额：¥{pendingRechargeAmount}</p>
              </div>
              <button
                className="text-zinc-400 hover:text-zinc-700"
                onClick={() => setShowPaymentModal(false)}
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3 mb-4">
              <button
                onClick={() => setPaymentMethod('wechat')}
                className={`h-11 rounded-xl border text-sm font-medium transition ${
                  paymentMethod === 'wechat'
                    ? 'bg-gradient-to-r from-[#dde9ff] to-[#f9efff] border-transparent text-[#266eff]'
                    : 'border-zinc-200 text-zinc-700 hover:bg-zinc-50'
                }`}
              >
                微信支付
              </button>
              <button
                onClick={() => setPaymentMethod('alipay')}
                className={`h-11 rounded-xl border text-sm font-medium transition ${
                  paymentMethod === 'alipay'
                    ? 'bg-gradient-to-r from-[#dde9ff] to-[#f9efff] border-transparent text-[#266eff]'
                    : 'border-zinc-200 text-zinc-700 hover:bg-zinc-50'
                }`}
              >
                支付宝支付
              </button>
            </div>

            <div className="rounded-2xl border border-zinc-200 bg-zinc-50 p-4 text-center">
              <div className="mb-2 text-base font-semibold text-zinc-800">充值金额：¥{pendingRechargeAmount}</div>
              <p className="text-sm text-zinc-600 mb-3">
                请使用{paymentMethod === 'wechat' ? '微信' : '支付宝'}扫码支付
              </p>
              <img
                src={
                  paymentMethod === 'wechat'
                    ? 'https://dummyimage.com/260x260/f3f4f6/16a34a.png&text=WeChat+Pay+QR'
                    : 'https://dummyimage.com/260x260/f3f4f6/2563eb.png&text=Alipay+QR'
                }
                alt={paymentMethod === 'wechat' ? '微信收款码' : '支付宝收款码'}
                className="w-52 h-52 mx-auto rounded-xl border border-zinc-200 object-cover bg-white"
              />
            </div>

            <button
              onClick={handlePaymentSuccess}
              className="w-full h-12 mt-4 rounded-xl bg-gradient-to-r from-[#dde9ff] to-[#f9efff] text-[#266eff] text-base font-semibold hover:brightness-95 transition"
            >
              我已完成支付
            </button>
          </div>
        </div>
      )}

      {showAvatarModal && (
        <div className="fixed inset-0 bg-black/55 z-[72] flex items-center justify-center p-4" onClick={() => setShowAvatarModal(false)}>
          <div className="w-full max-w-xl bg-white rounded-2xl p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-xl font-semibold text-zinc-900 mb-4">修改头像</h3>

            <div className="inline-flex bg-zinc-100 rounded-xl p-1 mb-4">
              <button
                onClick={() => setAvatarMode('default')}
                className={`px-4 h-10 rounded-lg text-sm ${avatarMode === 'default' ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-600'}`}
              >
                默认头像
              </button>
              <button
                onClick={() => setAvatarMode('upload')}
                className={`px-4 h-10 rounded-lg text-sm ${avatarMode === 'upload' ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-600'}`}
              >
                上传图片
              </button>
            </div>

            {avatarMode === 'default' ? (
              <div className="grid grid-cols-3 gap-3 mb-5">
                {DEFAULT_AVATAR_OPTIONS.map((item) => (
                  <button
                    key={item.key}
                    onClick={() => setAvatarDefaultKey(item.key)}
                    className={`rounded-xl border p-3 flex items-center gap-2 transition ${
                      avatarDefaultKey === item.key ? 'border-[#266eff] bg-[#f3f7ff]' : 'border-zinc-200 hover:bg-zinc-50'
                    }`}
                  >
                    <div className={`w-9 h-9 rounded-full bg-gradient-to-br ${item.bgClass} text-white flex items-center justify-center`}>
                      {item.emoji}
                    </div>
                    <span className="text-sm text-zinc-700">{item.label}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="mb-5">
                <label className="block text-sm text-zinc-600 mb-2">上传图片（PNG/JPG/WEBP/GIF，建议小于1MB）</label>
                <input
                  ref={avatarFileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  onChange={onAvatarFileChange}
                  className="hidden"
                />
                <div className="mt-3">
                  <button
                    type="button"
                    onClick={() => avatarFileInputRef.current?.click()}
                    className="w-24 h-24 rounded-full border border-zinc-200 bg-zinc-50 hover:bg-zinc-100 flex items-center justify-center overflow-hidden"
                    title="点击上传头像"
                  >
                    {avatarUploadDataUrl ? (
                      <img src={avatarUploadDataUrl} alt="头像预览" className="w-full h-full object-cover" />
                    ) : (
                      <Plus className="w-7 h-7 text-zinc-500" />
                    )}
                  </button>
                  <div className="text-xs text-zinc-500 mt-2">点击圆形区域上传或替换头像</div>
                </div>
              </div>
            )}

            <div className="flex gap-3">
              <button
                onClick={() => setShowAvatarModal(false)}
                className="flex-1 h-11 rounded-xl border border-zinc-300 text-zinc-700 hover:bg-zinc-100"
              >
                取消
              </button>
              <button
                onClick={saveAvatar}
                disabled={avatarSubmitting}
                className="flex-1 h-11 rounded-xl btn-brand-gradient disabled:opacity-60"
              >
                {avatarSubmitting ? '保存中...' : '确认修改'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showUsernameModal && (
        <div className="fixed inset-0 bg-black/55 z-[72] flex items-center justify-center p-4" onClick={() => setShowUsernameModal(false)}>
          <div className="w-full max-w-md bg-white rounded-2xl p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-xl font-semibold text-zinc-900 mb-4">修改用户名</h3>
            <div className="mb-4">
              <label className="block text-sm text-zinc-600 mb-1">新用户名</label>
              <input
                value={profileUsername}
                onChange={(e) => setProfileUsername(e.target.value)}
                className="w-full h-11 bg-[#f5f7fa] border border-zinc-200 rounded-xl px-3 text-zinc-800"
                placeholder="请输入用户名（1-12位）"
              />
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => setShowUsernameModal(false)}
                className="flex-1 h-11 rounded-xl border border-zinc-300 text-zinc-700 hover:bg-zinc-100"
              >
                取消
              </button>
              <button
                onClick={saveProfileUsername}
                disabled={profileSubmitting}
                className="flex-1 h-11 rounded-xl btn-brand-gradient disabled:opacity-60"
              >
                {profileSubmitting ? '保存中...' : '确认修改'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showPasswordModal && (
        <div className="fixed inset-0 bg-black/55 z-[72] flex items-center justify-center p-4" onClick={() => setShowPasswordModal(false)}>
          <div className="w-full max-w-md bg-white rounded-2xl p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-xl font-semibold text-zinc-900 mb-4">修改密码</h3>
            <div className="space-y-3 mb-4">
              <input
                type="password"
                value={passwordCurrent}
                onChange={(e) => setPasswordCurrent(e.target.value)}
                className="w-full h-11 bg-[#f5f7fa] border border-zinc-200 rounded-xl px-3 text-zinc-800"
                placeholder="当前密码"
              />
              <input
                type="password"
                value={passwordNext}
                onChange={(e) => setPasswordNext(e.target.value)}
                className="w-full h-11 bg-[#f5f7fa] border border-zinc-200 rounded-xl px-3 text-zinc-800"
                placeholder="新密码（8-10位字母+数字）"
              />
              <input
                type="password"
                value={passwordConfirm}
                onChange={(e) => setPasswordConfirm(e.target.value)}
                className="w-full h-11 bg-[#f5f7fa] border border-zinc-200 rounded-xl px-3 text-zinc-800"
                placeholder="确认新密码"
              />
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => setShowPasswordModal(false)}
                className="flex-1 h-11 rounded-xl border border-zinc-300 text-zinc-700 hover:bg-zinc-100"
              >
                取消
              </button>
              <button
                onClick={savePassword}
                disabled={passwordSubmitting}
                className="flex-1 h-11 rounded-xl btn-brand-gradient disabled:opacity-60"
              >
                {passwordSubmitting ? '提交中...' : '确认修改'}
              </button>
            </div>
          </div>
        </div>
      )}

      <button
        onClick={() => setShowAdvisorModal(true)}
        className="fixed right-8 bottom-8 z-40 w-20 h-20 rounded-full bg-gradient-to-br from-sky-500 to-violet-500 shadow-xl shadow-violet-400/30 flex flex-col items-center justify-center text-white hover:translate-y-[-2px] transition"
      >
        <MessageCircle className="w-7 h-7" />
        <span className="text-xs mt-0.5">专属顾问</span>
      </button>

      {showAdvisorModal && (
        <div className="fixed inset-0 bg-black/60 z-[70] flex items-center justify-center p-4" onClick={() => setShowAdvisorModal(false)}>
          <div
            className="bg-white rounded-3xl p-8 text-center relative shadow-2xl max-w-sm w-full"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="absolute right-4 top-4 text-zinc-400 hover:text-zinc-700"
              onClick={() => setShowAdvisorModal(false)}
            >
              <X className="w-5 h-5" />
            </button>
            <h3 className="text-zinc-900 text-xl font-semibold mb-2">联系专属顾问</h3>
            <p className="text-zinc-500 text-sm mb-5">扫描下方二维码添加微信</p>
            <img
              src="https://dummyimage.com/240x240/f3f4f6/999.png&text=WeChat+QR"
              alt="顾问二维码"
              className="w-56 h-56 mx-auto rounded-xl border border-zinc-200 object-cover"
            />
          </div>
        </div>
      )}

      {navigatingSlug && (
        <div className="fixed inset-0 z-[75] bg-black/35 backdrop-blur-[1px] flex items-center justify-center p-4">
          <div className="w-full max-w-2xl bg-white rounded-2xl border border-zinc-200 p-6 shadow-2xl">
            <div className="text-sm text-zinc-600 mb-4">正在进入工作流详情...</div>

            <div className="space-y-4 animate-pulse">
              <div className="h-5 w-1/2 rounded bg-zinc-200" />
              <div className="h-4 w-1/3 rounded bg-zinc-200" />
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
                <div className="h-44 rounded-xl bg-zinc-100 border border-zinc-200" />
                <div className="h-44 rounded-xl bg-zinc-100 border border-zinc-200" />
              </div>
            </div>
          </div>
        </div>
      )}

      <style jsx global>{`
        button:focus-visible,
        a:focus-visible,
        summary:focus-visible,
        input:focus-visible,
        select:focus-visible,
        textarea:focus-visible {
          outline: none;
          box-shadow: 0 0 0 2px rgba(252, 211, 77, 0.85), 0 0 0 4px rgba(255, 255, 255, 0.95);
          border-color: rgba(252, 211, 77, 0.85) !important;
        }

        .no-focus-ring:focus-visible {
          box-shadow: none !important;
          border-color: transparent !important;
        }
      `}</style>
    </div>
  );
}
