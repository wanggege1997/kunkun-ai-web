// app/page.tsx
'use client';
/* eslint-disable @next/next/no-img-element */

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type MouseEvent as ReactMouseEvent, type WheelEvent as ReactWheelEvent } from 'react';
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
import { useUserBalance, setUserBalance, setUserAuthState, refreshUserBalance } from '@/lib/user-balance-store';

type TaskStatus = 'submitting' | 'queueing' | 'running' | 'success' | 'failed' | 'timeout' | 'cancelled';
type DeliveryStatus = 'none' | 'pending' | 'retrying' | 'delivered' | 'failed';
type ActiveView = 'workflows' | 'history' | 'recharge' | 'referral' | 'help';
type RechargeTab = 'user' | 'points';
type RechargeChannel = 'wechat' | 'alipay';
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

type ValidationRule = {
  label: string;
  valid: boolean;
  submitMessage?: string;
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

type DisabledWorkflowStatus = {
  workflowId: string;
  disabled: boolean;
  reason?: string;
  disabledAt?: string;
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

type PendingPayOrder = {
  orderNo: string;
  channel: 'wechat' | 'alipay';
  amountFen: number;
  points: number;
  status: string;
  createdAt: string;
  expireAt: string;
  remainingSeconds: number;
};

const LOCAL_QUEUE_OPTIMISTIC_TTL_MS = 20_000;

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

function getSafeReturnTo(value: string | null) {
  if (!value) return '';
  if (!value.startsWith('/') || value.startsWith('//')) return '';
  if (value.startsWith('/api/')) return '';
  return value;
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
const ACCOUNT_RE = /^\d{8,12}$/;

function buildPasswordPolicyRules(value: string, submitFieldName: string): ValidationRule[] {
  const lengthValid = value.length >= 8 && value.length <= 20;
  const letterValid = /[A-Za-z]/.test(value);
  const numberValid = /\d/.test(value);
  const charsetValid = /^[A-Za-z\d]*$/.test(value);

  return [
    { label: '长度需在8-20位之间', valid: lengthValid, submitMessage: `${submitFieldName}长度需在8-20位之间` },
    { label: '至少包含1个字母', valid: letterValid, submitMessage: `${submitFieldName}需至少包含1个字母` },
    { label: '至少包含1个数字', valid: numberValid, submitMessage: `${submitFieldName}需至少包含1个数字` },
    { label: '仅支持字母和数字', valid: charsetValid, submitMessage: `${submitFieldName}仅支持字母和数字` },
  ];
}

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

function buildPageNumbers(current: number, total: number): Array<number | 'ellipsis'> {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }

  const pages: Array<number | 'ellipsis'> = [1];
  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);

  if (start > 2) pages.push('ellipsis');
  for (let page = start; page <= end; page += 1) pages.push(page);
  if (end < total - 1) pages.push('ellipsis');

  pages.push(total);
  return pages;
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
  const [queueCancellingIds, setQueueCancellingIds] = useState<Set<string>>(new Set());
  const [queueCancelLockedIds, setQueueCancelLockedIds] = useState<Set<string>>(new Set());
  const [queuePausedReason, setQueuePausedReason] = useState<QueuePauseReason | null>(null);
  const [workflowCenterLocked, setWorkflowCenterLocked] = useState(false);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyPageSize, setHistoryPageSize] = useState(20);
  const [usagePage, setUsagePage] = useState(1);
  const [usagePageSize, setUsagePageSize] = useState(20);
  const [selectedHistoryIds, setSelectedHistoryIds] = useState<string[]>([]);
  const [exportingHistory, setExportingHistory] = useState(false);
  const [previewZoom, setPreviewZoom] = useState(1);
  const [previewOffset, setPreviewOffset] = useState({ x: 0, y: 0 });
  const [isDraggingPreview, setIsDraggingPreview] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [imageLightboxOpen, setImageLightboxOpen] = useState(false);
  const [showAdvisorModal, setShowAdvisorModal] = useState(false);
  const [advisorPosition, setAdvisorPosition] = useState<{ x: number; y: number } | null>(null);
  const [isDraggingAdvisor, setIsDraggingAdvisor] = useState(false);
  const [navigatingSlug, setNavigatingSlug] = useState<string | null>(null);
  const [workflowPrechargePointsMap, setWorkflowPrechargePointsMap] = useState<Record<string, number>>({});
  const [selectedWorkflowTag, setSelectedWorkflowTag] = useState('全部');
  const [workflowKeyword, setWorkflowKeyword] = useState('');
  const [disabledWorkflowMap, setDisabledWorkflowMap] = useState<Record<string, DisabledWorkflowStatus>>({});
  const [rechargeRecords, setRechargeRecords] = useState<Array<{ id: string; codePreview: string; points: number; createdAt: number }>>([]);
  const [pointLedger, setPointLedger] = useState<PointLedgerItem[]>([]);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [authAccount, setAuthAccount] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authPasswordConfirm, setAuthPasswordConfirm] = useState('');
  const [authReturnTo, setAuthReturnTo] = useState('');
  const [showAuthPassword, setShowAuthPassword] = useState(false);
  const [showAuthPasswordConfirm, setShowAuthPasswordConfirm] = useState(false);
  const [showPasswordCurrent, setShowPasswordCurrent] = useState(false);
  const [showPasswordNext, setShowPasswordNext] = useState(false);
  const [showPasswordConfirm, setShowPasswordConfirm] = useState(false);
  const [authError, setAuthError] = useState('');
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [sessionExpiredNotice, setSessionExpiredNotice] = useState('');
  const [siteNoticeText, setSiteNoticeText] = useState('平台功能持续升级中，如遇问题请联系顾问');
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);
  const [rechargeTab, setRechargeTab] = useState<RechargeTab>('user');
  const [redeemCodeInput, setRedeemCodeInput] = useState('');
  const [redeemSubmitting, setRedeemSubmitting] = useState(false);
  const [pendingPayOrders, setPendingPayOrders] = useState<PendingPayOrder[]>([]);
  const [pendingPayTick, setPendingPayTick] = useState<number>(Date.now());
  const [closingPendingPayOrder, setClosingPendingPayOrder] = useState(false);
  const [rechargeAmountInput, setRechargeAmountInput] = useState('');
  const [selectedRechargePreset, setSelectedRechargePreset] = useState<number | null>(null);
  const [rechargeChannel, setRechargeChannel] = useState<RechargeChannel>('wechat');
  const [rechargeCooldownSeconds, setRechargeCooldownSeconds] = useState(0);
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
  const advisorButtonRef = useRef<HTMLButtonElement | null>(null);
  const avatarFileInputRef = useRef<HTMLInputElement | null>(null);
  const userMenuRef = useRef<HTMLDivElement | null>(null);
  const enqueueRetryRequestIdRef = useRef<Map<string, { requestId: string; expiresAt: number }>>(new Map());
  const advisorPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const advisorDragStartRef = useRef({ x: 0, y: 0, offsetX: 0, offsetY: 0 });
  const advisorLongPressActiveRef = useRef(false);
  const advisorSuppressClickRef = useRef(false);

  const currentWorkflowIsAudio = useMemo(
    () => !!selectedWorkflow?.inputs.some((i) => i.type === 'audio'),
    [selectedWorkflow]
  );
  const authUserId = authUser?.id;
  const authUserPoints = authUser?.points;
  const userBalanceState = useUserBalance();
  const balance = userBalanceState.balance ?? 0;

  const getWorkflowDisableMeta = useCallback((workflowId: string) => {
    return disabledWorkflowMap[workflowId] || null;
  }, [disabledWorkflowMap]);

  const mergeServerQueueWithLocal = useCallback((serverQueue: QueueTask[], localQueue: QueueTask[]) => {
    if (localQueue.length === 0) return serverQueue;

    const now = Date.now();
    const serverHistoryIds = new Set(
      serverQueue
        .map((item) => item.historyId)
        .filter((id): id is string => Boolean(id))
    );
    const serverRequestIds = new Set(
      serverQueue
        .map((item) => item.requestId)
        .filter((id): id is string => Boolean(id))
    );

    const optimisticLocal = localQueue.filter((item) => {
      if (now - item.createdAt > LOCAL_QUEUE_OPTIMISTIC_TTL_MS) return false;
      if (item.historyId && serverHistoryIds.has(item.historyId)) return false;
      if (item.requestId && serverRequestIds.has(item.requestId)) return false;
      return true;
    });

    if (optimisticLocal.length === 0) return serverQueue;

    return [...serverQueue, ...optimisticLocal].sort((a, b) => {
      if (a.state === 'running' && b.state !== 'running') return -1;
      if (a.state !== 'running' && b.state === 'running') return 1;
      return a.createdAt - b.createdAt;
    });
  }, []);

  const fetchSiteNotice = useCallback(async () => {
    try {
      const response = await fetch('/api/system/notice', { cache: 'no-store' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.success) return;
      const text = String(data?.data?.text || '').trim();
      if (text) setSiteNoticeText(text);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    void fetchSiteNotice();
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      void fetchSiteNotice();
    }, 30000);
    return () => clearInterval(timer);
  }, [fetchSiteNotice]);

  const getEffectiveWorkflowPointCost = useCallback((workflowId: string) => {
    const syncedPoints = workflowPrechargePointsMap[workflowId];
    if (typeof syncedPoints === 'number' && Number.isFinite(syncedPoints) && syncedPoints >= 0) {
      return Math.floor(syncedPoints);
    }
    return getWorkflowPointCostById(workflowId);
  }, [workflowPrechargePointsMap]);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch('/api/workflow-precharge-points', { cache: 'no-store' });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data?.success) return;
        const source = data?.data?.pointsMap;
        if (!source || typeof source !== 'object') {
          setWorkflowPrechargePointsMap({});
          return;
        }
        const nextMap: Record<string, number> = {};
        for (const [workflowId, value] of Object.entries(source as Record<string, unknown>)) {
          const n = Math.floor(Number(value));
          if (Number.isFinite(n) && n >= 0) {
            nextMap[workflowId] = n;
          }
        }
        setWorkflowPrechargePointsMap(nextMap);
      } catch {
        // ignore
      }
    })();
  }, []);

  useEffect(() => {
    if (!authUserId) {
      setDisabledWorkflowMap({});
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const fetchDisabledWorkflows = async () => {
      try {
        const response = await fetch('/api/workflows/disabled', { cache: 'no-store' });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data?.success || !Array.isArray(data.data)) return;
        if (cancelled) return;
        const nextMap: Record<string, DisabledWorkflowStatus> = {};
        for (const row of data.data as DisabledWorkflowStatus[]) {
          const workflowId = String(row?.workflowId || '');
          if (!workflowId) continue;
          nextMap[workflowId] = {
            workflowId,
            disabled: Boolean(row?.disabled),
            reason: String(row?.reason || ''),
            disabledAt: String(row?.disabledAt || ''),
          };
        }
        setDisabledWorkflowMap(nextMap);
      } catch {
        // ignore
      }
    };

    void fetchDisabledWorkflows();
    timer = setInterval(() => {
      void fetchDisabledWorkflows();
    }, 30_000);

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [authUserId, mergeServerQueueWithLocal]);

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
    let initialReturnTo = '';

    try {
      const params = new URLSearchParams(window.location.search);
      const returnTo = getSafeReturnTo(params.get('returnTo'));
      initialReturnTo = returnTo;
      if (returnTo) setAuthReturnTo(returnTo);
      if (params.get('login') === '1') {
        setAuthMode('login');
        setAuthError('');
      }
      if (params.get('expired') === '1') {
        setSessionExpiredNotice('登录状态已失效，请重新登录。');
      }
    } catch {
      // ignore URL parsing errors
    }

    // 立即从缓存恢复登录状态
    try {
      const cached = window.localStorage.getItem('auth_user_cache');
      if (cached) {
        const cachedUser = JSON.parse(cached) as AuthUser;
        if (!cancelled) setAuthUser(cachedUser);
      }
    } catch { /* ignore */ }

    // 后台验证 session 是否仍然有效
    void (async () => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const response = await fetch('/api/me', { cache: 'no-store', signal: controller.signal });
        clearTimeout(timeout);
        const data = await response.json().catch(() => null);
        if (!cancelled) {
          if (data?.success && data?.data) {
            setAuthUser(data.data);
            try { window.localStorage.setItem('auth_user_cache', JSON.stringify(data.data)); } catch { /* ignore */ }
            setSessionExpiredNotice('');
            if (initialReturnTo) {
              window.location.replace(initialReturnTo);
            }
          } else if (response.status === 401) {
            // 仅在明确未授权时退出登录
            setAuthUser(null);
            try {
              window.localStorage.removeItem('auth_user_cache');
              window.localStorage.removeItem(BALANCE_KEY);
              setUserAuthState(false);
            } catch { /* ignore */ }
          }
        }
      } catch {
        // 网络异常时保留当前登录态，避免误踢下线
      } finally {
        // no-op
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

  const ensureSessionForAction = async (): Promise<AuthUser | null> => {
    try {
      const response = await fetch('/api/me', { cache: 'no-store' });
      const data = await response.json().catch(() => null);
      if (response.ok && data?.success && data?.data) {
        setAuthUser(data.data);
        try { window.localStorage.setItem('auth_user_cache', JSON.stringify(data.data)); } catch { /* ignore */ }
        return data.data as AuthUser;
      }
    } catch {
      // ignore network issues here
    }

    setAuthUser(null);
    setIsUserMenuOpen(false);
    setShowAvatarModal(false);
    setShowUsernameModal(false);
    setShowPasswordModal(false);
    setSessionExpiredNotice('登录态已失效，请重新登录。');
    try {
      window.localStorage.removeItem('auth_user_cache');
      window.localStorage.removeItem(BALANCE_KEY);
      setUserAuthState(false);
    } catch { /* ignore */ }
    setAuthMode('login');
    setAuthError('请先登录后再继续操作');
    return null;
  };

  useEffect(() => {
    if (!authUserId) return;

    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const refreshMe = async () => {
      try {
        const response = await fetch('/api/me', { cache: 'no-store' });
        const data = await response.json().catch(() => null);
        if (!cancelled && response.ok && data?.success && data?.data) {
          setAuthUser(data.data as AuthUser);
          try {
            window.localStorage.setItem('auth_user_cache', JSON.stringify(data.data));
          } catch {
            // ignore
          }
        }
      } catch {
        // ignore
      }
    };

    const onFocusRefresh = () => {
      void refreshMe();
    };

    void refreshMe();
    window.addEventListener('focus', onFocusRefresh);
    document.addEventListener('visibilitychange', onFocusRefresh);
    timer = setInterval(() => {
      void refreshMe();
    }, 30_000);

    return () => {
      cancelled = true;
      window.removeEventListener('focus', onFocusRefresh);
      document.removeEventListener('visibilitychange', onFocusRefresh);
      if (timer) clearInterval(timer);
    };
  }, [authUserId, mergeServerQueueWithLocal]);

  useEffect(() => {
    setProfileUsername(authUser?.username ?? '');
  }, [authUser?.username]);

  useEffect(() => {
    if (authUserPoints == null) return;

    setUserBalance(authUserPoints);
  }, [authUserId, authUserPoints]);

  useEffect(() => {
    if (!authUserId) return;

    void refreshUserBalance();
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      void refreshUserBalance();
    }, 10_000);

    const onFocus = () => {
      void refreshUserBalance();
    };

    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);

    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [authUserId, mergeServerQueueWithLocal]);

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
        const response = await fetch('/api/me/tasks?page=1&pageSize=20', { cache: 'no-store' });
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
          setTaskQueue((prev) => mergeServerQueueWithLocal(queueFromServer, prev));
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
  }, [authUserId, mergeServerQueueWithLocal]);

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
    const rawRecords = window.localStorage.getItem(RECHARGE_RECORDS_KEY);
    if (rawRecords) {
      try {
        const parsed = JSON.parse(rawRecords);
        if (Array.isArray(parsed)) {
          const now = Date.now();
          const normalized = parsed
            .map((r) => {
              const createdAt = Number(r?.createdAt || now);
              const points = Number(r?.points || 0);
              const codePreview = String(r?.codePreview || '历史记录');
              return {
                id: String(r?.id || `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`),
                codePreview,
                points: Number.isFinite(points) ? points : 0,
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
    const ids = new Set(taskQueue.map((item) => item.id));
    setQueueCancellingIds((prev) => {
      const next = new Set(Array.from(prev).filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
    setQueueCancelLockedIds((prev) => {
      const next = new Set(Array.from(prev).filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [taskQueue]);

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
      const res = await fetch('/api/ai', {
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
    if (!authUserId) {
      const freshUser = await ensureSessionForAction();
      if (!freshUser?.id) return;
    } else {
      void ensureSessionForAction();
    }

    if (workflowCenterLocked) {
      toast.error('工作流中心已临时禁用，请等待问题修复后再使用');
      return;
    }

    if (queuePausedReason) {
      toast.error(queuePauseMessage(queuePausedReason));
      return;
    }

    const pointsCost = payload.pointsCost ?? getEffectiveWorkflowPointCost(payload.workflowId);

    if (balance < pointsCost) {
      toast.error(`积分不足，当前 ${balance} 积分，本次需要 ${pointsCost} 积分`);
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
          updateHistoryItem(historyId, {
            status: 'cancelled',
            error: enqueueData?.message || '任务入队失败',
          });
          toast.error(enqueueData?.message || '任务入队失败');
          return;
        }

        if (typeof enqueueData?.data?.points === 'number') {
          setUserBalance(Number(enqueueData.data.points));
        }

        if (Number(enqueueData?.data?.queued || 0) === 0 && Number(enqueueData?.data?.duplicated || 0) > 0) {
          updateHistoryItem(historyId, {
            status: 'cancelled',
            error: '请求重复，已忽略本次入队',
          });
          toast.info('检测到重复请求，系统已自动去重');
          return;
        }

        if (Number(enqueueData?.data?.queued || 0) === 0 && Number(enqueueData?.data?.insufficientPoints || 0) > 0) {
          updateHistoryItem(historyId, {
            status: 'cancelled',
            error: '积分不足，任务未入队',
          });
          toast.error('积分不足，任务未入队');
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
        addPointLedgerItem({
          type: 'expense',
          points: pointsCost,
          reason: `任务积分预占：${payload.workflowTitle}`,
          relatedId: payload.workflowId,
        });
        toast.info(`任务已入队，已预占 ${pointsCost} 积分`);
        return;
      } catch {
        enqueueRetryRequestIdRef.current.set(retryKey, {
          requestId,
          expiresAt: Date.now() + REQUEST_ID_REUSE_WINDOW_MS,
        });
        updateHistoryItem(historyId, {
          status: 'cancelled',
          error: '任务入队失败，请稍后重试',
        });
        toast.error('任务入队失败，请稍后重试');
        return;
      }
    }

    toast.info(`任务已入队，已预占 ${pointsCost} 积分`);
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
    const pointsCost = next.payload.pointsCost ?? getEffectiveWorkflowPointCost(next.payload.workflowId);
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
    let timer: number | null = null;
    let round = 0;

    const nextDelay = (hasActiveTasks: boolean) => {
      const hidden = typeof document !== 'undefined' && document.visibilityState !== 'visible';
      if (hasActiveTasks) {
        if (round < 4) return 1500;
        if (round < 12) return hidden ? 5000 : 3000;
        return hidden ? 9000 : 5000;
      }
      return hidden ? 20000 : 12000;
    };

    const sync = async () => {
      try {
        const response = await fetch('/api/me/tasks?page=1&pageSize=200', { cache: 'no-store' });
        const data = await response.json().catch(() => null);
        if (!response.ok || !data?.success || cancelled) return false;
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
        setTaskQueue((prev) => mergeServerQueueWithLocal(mappedQueue, prev));
        return mappedQueue.length > 0;
      } catch {
        return false;
      }
    };

    const runLoop = async () => {
      const hasActiveTasks = await sync();
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

    void runLoop();
    window.addEventListener('focus', forceRefresh);
    document.addEventListener('visibilitychange', forceRefresh);

    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      window.removeEventListener('focus', forceRefresh);
      document.removeEventListener('visibilitychange', forceRefresh);
    };
  }, [authUserId, mergeServerQueueWithLocal]);

  const handleGenerate = async () => {
    if (!selectedWorkflow) return;

    const disableMeta = getWorkflowDisableMeta(selectedWorkflow.workflowId);
    if (disableMeta?.disabled) {
      toast.error(`该应用已下架/维护中${disableMeta.reason ? `（${disableMeta.reason}）` : ''}`);
      return;
    }

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
      pointsCost: getEffectiveWorkflowPointCost(selectedWorkflow.workflowId),
    });
  };

  const retryHistoryItem = async (item: HistoryItem) => {
    const freshUser = await ensureSessionForAction();
    if (!freshUser?.id) return;

    if (!item.retryPayload) {
      toast.error('该记录无重试参数（可能是刷新后历史），请重新手动提交一次');
      return;
    }

    await runTask({ ...item.retryPayload, requestId: createRequestId() });
  };

  const confirmCancelResult = async (recordId: string, queueId: string) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));

    try {
      const response = await fetch(
        `/api/me/tasks?keyword=${encodeURIComponent(recordId)}&page=1&pageSize=50`,
        { cache: 'no-store' }
      );
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.success) {
        toast.info('取消结果确认中，请稍后刷新查看');
        return;
      }

      const records = Array.isArray(data.data?.records) ? data.data.records : [];
      const row = records.find((item: { id?: string }) => String(item.id || '') === recordId);
      if (!row) {
        toast.info('取消结果确认中，请稍后刷新查看');
        return;
      }

      const status = String(row.status || '');
      if (status === 'cancelled') {
        toast.success('取消确认：任务已取消');
        setQueueCancelLockedIds((prev) => {
          const next = new Set(prev);
          next.delete(queueId);
          return next;
        });
        return;
      }

      if (status === 'success') {
        setQueueCancelLockedIds((prev) => {
          const next = new Set(prev);
          next.add(queueId);
          return next;
        });
        toast.info('取消确认：任务已完成生成，取消未生效');
        return;
      }

      if (['failed', 'timeout'].includes(status)) {
        toast.info(`取消确认：任务已结束（${status}）`);
        return;
      }

      toast.info('取消结果确认中，请稍后刷新查看');
    } catch {
      toast.info('取消结果确认中，请稍后刷新查看');
    }
  };

  const cancelQueuedTask = (queueId: string) => {
    void (async () => {
      const freshUser = await ensureSessionForAction();
      if (!freshUser?.id) return;

      const target = taskQueue.find((t) => t.id === queueId);
      if (!target) return;
      if (queueCancellingIds.has(queueId)) return;
      if (queueCancelLockedIds.has(queueId)) {
        toast.info('该任务已在后台完成生成，无法取消');
        return;
      }

    if (SERVER_QUEUE_EXECUTOR_ENABLED) {
      void (async () => {
        setQueueCancellingIds((prev) => {
          const next = new Set(prev);
          next.add(queueId);
          return next;
        });
        try {
          const recordId = target.historyId || (queueId.startsWith('srv-') ? queueId.slice(4) : queueId);
          const response = await fetch('/api/tasks/cancel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: recordId }),
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok || !data?.success) {
            if (response.status === 409 || String(data?.message || '').includes('已完成生成')) {
              setQueueCancelLockedIds((prev) => {
                const next = new Set(prev);
                next.add(queueId);
                return next;
              });
              void confirmCancelResult(recordId, queueId);
            }
            toast.error(data?.message || '取消任务失败');
            return;
          }

          setTaskQueue((prev) => prev.filter((t) => t.id !== queueId));
          setQueueCancelLockedIds((prev) => {
            const next = new Set(prev);
            next.delete(queueId);
            return next;
          });
          if (target.historyId) {
            updateHistoryItem(target.historyId, {
              status: 'cancelled',
              error: '任务已取消（服务端队列）',
            });
          }

          const refundPoints = Number(data?.data?.pointsDelta || 0);
          const chargedPoints = Math.max(0, Number(data?.data?.chargedPoints || 0));
          if (Boolean(data?.data?.refunded) && refundPoints > 0) {
            setUserBalance(balance + refundPoints);
          }
          if (target.state === 'running') {
            toast.success(`执行中，实扣 ${chargedPoints} / 返还 ${refundPoints} 积分`);
          } else {
            toast.success(`未执行，已全额返还 ${refundPoints} 积分`);
          }
          void confirmCancelResult(recordId, queueId);
        } catch {
          toast.error('取消任务失败，请稍后重试');
        } finally {
          setQueueCancellingIds((prev) => {
            const next = new Set(prev);
            next.delete(queueId);
            return next;
          });
        }
      })();
      return;
    }

    if (target.state === 'running') {
      toast.error('执行中任务不支持手动取消，系统将按失败规则自动暂停后续任务');
      return;
    }

    const refundPoints = target.payload.pointsCost ?? getEffectiveWorkflowPointCost(target.payload.workflowId);

    void (async () => {
      try {
        const refundRes = await fetch('/api/tasks/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: queueId }),
        });
        const refundData = await refundRes.json().catch(() => ({}));
        if (!refundRes.ok || !refundData?.success) {
          toast.error(refundData?.message || '返还积分失败，请稍后再试');
          return;
        }

        setTaskQueue((prev) => prev.filter((t) => t.id !== queueId));
        const pointsDelta = Math.max(0, Number(refundData?.data?.pointsDelta ?? refundPoints));
        setUserBalance(balance + pointsDelta);
        addPointLedgerItem({
          type: 'income',
          points: pointsDelta,
          reason: `排队取消返还：${target.payload.workflowTitle}`,
          relatedId: target.payload.workflowId,
        });
        if (target.historyId) {
          updateHistoryItem(target.historyId, {
            status: 'cancelled',
            error: '任务已取消（未执行，已返还该任务消耗的积分）',
          });
        }
        toast.success(`已取消排队任务，返还 ${pointsDelta} 积分`);
      } catch {
        toast.error('返还积分失败，请稍后再试');
      }
    })();
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
      const disabledMeta = getWorkflowDisableMeta(wf.workflowId);
      if (disabledMeta?.disabled) return false;

      const tagOk = selectedWorkflowTag === '全部' || wf.category === selectedWorkflowTag;
      const kwOk =
        !kw ||
        wf.title.toLowerCase().includes(kw) ||
        wf.description.toLowerCase().includes(kw) ||
        wf.category.toLowerCase().includes(kw);
      return tagOk && kwOk;
    });
  }, [getWorkflowDisableMeta, selectedWorkflowTag, workflowKeyword]);

  const redeemPointsByCode = () => {
    const code = redeemCodeInput.trim();
    if (!code) {
      toast.error('请输入兑换码');
      return;
    }

    if (redeemSubmitting) return;

    void (async () => {
      setRedeemSubmitting(true);
      try {
        const response = await fetch('/api/redeem-codes/redeem', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data?.success) {
          toast.error(data?.message || '兑换失败，请稍后重试');
          return;
        }

        const addedPoints = Number(data?.data?.addedPoints || 0);
        const nextPoints = Number(data?.data?.points || balance + addedPoints);
        setUserBalance(nextPoints);
        setAuthUser((prev) => (prev ? { ...prev, points: nextPoints } : prev));

        setRechargeRecords((prev) => [
          {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            codePreview: `${code.slice(0, 4).toUpperCase()}-****-${code.slice(-4).toUpperCase()}`,
            points: addedPoints,
            createdAt: Date.now(),
          },
          ...prev,
        ]);

        addPointLedgerItem({
          type: 'income',
          points: addedPoints,
          reason: '兑换码积分到账',
        });
        setRedeemCodeInput('');
        toast.success(`兑换成功 +${addedPoints} 积分`);
      } catch {
        toast.error('兑换失败，请稍后重试');
      } finally {
        setRedeemSubmitting(false);
      }
    })();
  };

  const openRechargePayModal = () => {
    if (rechargeCooldownSeconds > 0) {
      toast.error(`操作过于频繁，请 ${rechargeCooldownSeconds} 秒后再试`);
      return;
    }

    const amount = Number(rechargeAmountInput);
    if (!Number.isInteger(amount) || amount < 10) {
      toast.error('请输入不小于 10 元的整数金额');
      return;
    }

    const payWindow = window.open('/pay/creating', '_blank');
    if (!payWindow) {
      toast.error('浏览器拦截了新窗口，请允许弹窗后重试');
      return;
    }

    void (async () => {
      try {
        const response = await fetch('/api/pay/orders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            channel: rechargeChannel,
            amountFen: amount * 100,
            points: amount * 100,
          }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data?.success || !data?.data?.orderNo) {
          payWindow.close();
          if (response.status === 429) {
            setRechargeCooldownSeconds(60);
          }
          toast.error(data?.message || '创建充值订单失败');
          return;
        }
        const payUrl = `/pay/${data.data.orderNo}`;
        setPendingPayOrders((prev) => [{
          orderNo: data.data.orderNo,
          channel: rechargeChannel,
          amountFen: amount * 100,
          points: amount * 100,
          status: 'pending',
          createdAt: new Date().toISOString(),
          expireAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
          remainingSeconds: 15 * 60,
        }, ...prev.filter((item) => item.orderNo !== data.data.orderNo)].slice(0, 5));
        setRechargeAmountInput('');
        setSelectedRechargePreset(null);
        setRechargeChannel('wechat');
        payWindow.location.href = payUrl;
        payWindow.focus();
      } catch {
        payWindow.close();
        toast.error('创建充值订单失败，请稍后重试');
      }
    })();
  };

  useEffect(() => {
    if (rechargeCooldownSeconds <= 0) return;
    const timer = setInterval(() => {
      setRechargeCooldownSeconds((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [rechargeCooldownSeconds]);

  const fetchLatestPendingPayOrder = useCallback(async () => {
    try {
      const response = await fetch('/api/pay/orders/pending/latest', { cache: 'no-store' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.success) return;
      const list = Array.isArray(data?.data) ? (data.data as PendingPayOrder[]) : [];
      setPendingPayOrders(list);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (activeView !== 'recharge' || rechargeTab !== 'points') return;
    void fetchLatestPendingPayOrder();
  }, [activeView, rechargeTab, fetchLatestPendingPayOrder]);

  useEffect(() => {
    if (pendingPayOrders.length === 0) return;
    const timer = setInterval(() => {
      setPendingPayTick(Date.now());
    }, 1000);
    return () => clearInterval(timer);
  }, [pendingPayOrders.length]);

  useEffect(() => {
    if (pendingPayOrders.length === 0) return;
    const activeOrders = pendingPayOrders.filter((item) => {
      const expireAtMs = new Date(item.expireAt).getTime();
      if (Number.isNaN(expireAtMs)) return true;
      return expireAtMs - pendingPayTick > 0;
    });

    if (activeOrders.length !== pendingPayOrders.length) {
      setPendingPayOrders(activeOrders);
      toast.info('订单已过期');
      void fetchLatestPendingPayOrder();
    }
  }, [pendingPayOrders, pendingPayTick, fetchLatestPendingPayOrder]);

  const closePendingPayOrder = (orderNo: string) => {
    if (!orderNo || closingPendingPayOrder) return;
    setClosingPendingPayOrder(true);
    void (async () => {
      try {
        const response = await fetch(`/api/pay/orders/${orderNo}/close`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: 'user_manual_close' }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data?.success) {
          toast.error(data?.message || '关闭订单失败');
          return;
        }
        toast.success('待支付订单已关闭');
        await fetchLatestPendingPayOrder();
      } catch {
        toast.error('关闭订单失败，请稍后重试');
      } finally {
        setClosingPendingPayOrder(false);
      }
    })();
  };

  const openPendingPayOrder = (orderNo: string) => {
    if (!orderNo) return;
    const opened = window.open(`/pay/${orderNo}`, '_blank');
    if (!opened) {
      toast.error('浏览器拦截了新窗口，请允许弹窗后重试');
      return;
    }
    opened.focus();
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

  const clearAdvisorPressTimer = () => {
    if (!advisorPressTimerRef.current) return;
    clearTimeout(advisorPressTimerRef.current);
    advisorPressTimerRef.current = null;
  };

  const startAdvisorPress = (clientX: number, clientY: number) => {
    clearAdvisorPressTimer();
    advisorLongPressActiveRef.current = false;

    const buttonRect = advisorButtonRef.current?.getBoundingClientRect();
    const initialX = advisorPosition?.x ?? (buttonRect?.left ?? Math.max(window.innerWidth - 112, 0));
    const initialY = advisorPosition?.y ?? (buttonRect?.top ?? Math.max(window.innerHeight - 112, 0));

    advisorDragStartRef.current = {
      x: clientX,
      y: clientY,
      offsetX: clientX - initialX,
      offsetY: clientY - initialY,
    };

    advisorPressTimerRef.current = setTimeout(() => {
      advisorLongPressActiveRef.current = true;
      advisorSuppressClickRef.current = true;
      setAdvisorPosition((prev) => prev ?? { x: initialX, y: initialY });
      setIsDraggingAdvisor(true);
    }, 220);
  };

  const handleAdvisorDragMove = useCallback((clientX: number, clientY: number) => {
    if (!advisorLongPressActiveRef.current || !isDraggingAdvisor) return;

    const floatingSize = 80;
    const maxX = Math.max(window.innerWidth - floatingSize, 0);
    const maxY = Math.max(window.innerHeight - floatingSize, 0);
    const nextX = Math.min(Math.max(clientX - advisorDragStartRef.current.offsetX, 0), maxX);
    const nextY = Math.min(Math.max(clientY - advisorDragStartRef.current.offsetY, 0), maxY);

    setAdvisorPosition({ x: nextX, y: nextY });
  }, [isDraggingAdvisor]);

  const stopAdvisorDragging = useCallback(() => {
    clearAdvisorPressTimer();
    if (isDraggingAdvisor) {
      setIsDraggingAdvisor(false);
    }
    advisorLongPressActiveRef.current = false;
  }, [isDraggingAdvisor]);

  useEffect(() => {
    if (previewZoom <= 1) {
      setPreviewOffset({ x: 0, y: 0 });
    }
  }, [previewZoom]);

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      handleAdvisorDragMove(event.clientX, event.clientY);
    };

    const handleTouchMove = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch) return;
      handleAdvisorDragMove(touch.clientX, touch.clientY);
      if (advisorLongPressActiveRef.current) {
        event.preventDefault();
      }
    };

    const handleDragEnd = () => {
      stopAdvisorDragging();
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleDragEnd);
    window.addEventListener('touchmove', handleTouchMove, { passive: false });
    window.addEventListener('touchend', handleDragEnd);
    window.addEventListener('touchcancel', handleDragEnd);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleDragEnd);
      window.removeEventListener('touchmove', handleTouchMove);
      window.removeEventListener('touchend', handleDragEnd);
      window.removeEventListener('touchcancel', handleDragEnd);
      clearAdvisorPressTimer();
    };
  }, [handleAdvisorDragMove, stopAdvisorDragging]);

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

  const historyTotalPages = Math.max(1, Math.ceil(filteredHistory.length / historyPageSize));
  const historyPageSafe = Math.min(historyPage, historyTotalPages);
  const historyPageNumbers = useMemo(() => buildPageNumbers(historyPageSafe, historyTotalPages), [historyPageSafe, historyTotalPages]);
  const pagedHistory = useMemo(() => {
    const start = (historyPageSafe - 1) * historyPageSize;
    return filteredHistory.slice(start, start + historyPageSize);
  }, [filteredHistory, historyPageSafe, historyPageSize]);

  useEffect(() => {
    setHistoryPage(1);
  }, [historyRecordFilter, historyPageSize]);

  useEffect(() => {
    if (historyPage > historyTotalPages) {
      setHistoryPage(historyTotalPages);
    }
  }, [historyPage, historyTotalPages]);

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
  const authAccountTrimmed = authAccount.trim();
  const authAccountLengthValid = authAccountTrimmed.length >= 8 && authAccountTrimmed.length <= 12;
  const authAccountCharsetValid = /^\d*$/.test(authAccountTrimmed);
  const authAccountValid = ACCOUNT_RE.test(authAccountTrimmed);
  const authPasswordRules: ValidationRule[] = buildPasswordPolicyRules(authPassword, '密码');
  const authPasswordValid = authPasswordRules.every((rule) => rule.valid);
  const authPasswordConfirmValid = authMode !== 'register' || (authPasswordConfirm.length > 0 && authPassword === authPasswordConfirm);
  const authAccountRules: ValidationRule[] = [
    { label: '长度需在8-12位之间', valid: authAccountLengthValid, submitMessage: '账号长度需在8-12位之间' },
    { label: '仅支持数字', valid: authAccountCharsetValid, submitMessage: '账号仅支持数字' },
  ];
  const authPasswordConfirmRules: ValidationRule[] = [
    {
      label: '两次输入的密码保持一致',
      valid: authPasswordConfirm.length > 0 && authPassword === authPasswordConfirm,
      submitMessage: authPasswordConfirm.length === 0 ? '请再次输入确认密码' : '两次输入的密码需保持一致',
    },
  ];
  const authFormRules = [
    ...authAccountRules,
    ...authPasswordRules,
    ...(authMode === 'register' ? authPasswordConfirmRules : []),
  ];
  const passwordNextConfirmValid = passwordConfirm.length > 0 && passwordNext === passwordConfirm;
  const passwordNextRules: ValidationRule[] = buildPasswordPolicyRules(passwordNext, '新密码');
  const passwordCurrentRules: ValidationRule[] = [
    {
      label: '已输入当前密码',
      valid: passwordCurrent.length > 0,
      submitMessage: '请输入当前密码',
    },
  ];
  const passwordConfirmRules: ValidationRule[] = [
    {
      label: '两次新密码输入保持一致',
      valid: passwordNextConfirmValid,
      submitMessage: passwordConfirm.length === 0 ? '请再次输入新密码' : '两次新密码输入不一致',
    },
  ];
  const passwordChangeRules: ValidationRule[] = [
    ...passwordCurrentRules,
    ...passwordNextRules,
    ...passwordConfirmRules,
  ];
  const passwordChangeBlockedReason = passwordChangeRules.find((rule) => !rule.valid)?.submitMessage || '';
  const authSubmitBlockedReason = authFormRules.find((rule) => !rule.valid)?.submitMessage || '';

  const submitAuth = async () => {
    setAuthError('');

    const account = authAccountTrimmed;
    const password = authPassword;

    if (!authAccountValid || !authPasswordValid || !authPasswordConfirmValid) {
      const message = authSubmitBlockedReason || '请先完成表单填写';
      setAuthError(message);
      toast.error(message);
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
      try { window.localStorage.setItem('auth_user_cache', JSON.stringify(data.data)); } catch { /* ignore */ }
      setSessionExpiredNotice('');
      setAuthAccount('');
      setAuthPassword('');
      setAuthPasswordConfirm('');
      setIsUserMenuOpen(false);
      setRechargeTab('user');
      if (authReturnTo) {
        window.location.assign(authReturnTo);
      }
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
      try { window.localStorage.removeItem('auth_user_cache'); } catch { /* ignore */ }
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
    if (passwordChangeBlockedReason) {
      toast.error(passwordChangeBlockedReason);
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

  const usageTotalPages = Math.max(1, Math.ceil(usageRowsInProfile.length / usagePageSize));
  const usagePageSafe = Math.min(usagePage, usageTotalPages);
  const usagePageNumbers = useMemo(() => buildPageNumbers(usagePageSafe, usageTotalPages), [usagePageSafe, usageTotalPages]);
  const usageRowsPaged = useMemo(() => {
    const start = (usagePageSafe - 1) * usagePageSize;
    return usageRowsInProfile.slice(start, start + usagePageSize);
  }, [usageRowsInProfile, usagePageSafe, usagePageSize]);

  useEffect(() => {
    if (usagePage > usageTotalPages) {
      setUsagePage(usageTotalPages);
    }
  }, [usagePage, usageTotalPages]);

  if (!authUser) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-[#f0f4ff] to-[#f9f0ff] flex items-center justify-center p-4">
        <Toaster position="top-center" richColors />
        <div className="w-full max-w-md">
          {/* Logo区域 */}
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-[#266eff] to-[#a855f7] shadow-lg mb-4">
              <span className="text-3xl">✨</span>
            </div>
            <h1 className="text-3xl font-bold text-zinc-900">坤坤 AI</h1>
            <p className="text-sm text-zinc-500 mt-1">AI工作流调用平台</p>
          </div>

          <div className="bg-white border border-zinc-200 rounded-2xl p-6 shadow-xl">
            {sessionExpiredNotice ? (
              <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-700 flex items-start gap-2">
                <span className="mt-0.5">⚠️</span>
                <span>{sessionExpiredNotice}</span>
              </div>
            ) : null}

            {/* 登录/注册切换 */}
            <div className="inline-flex bg-zinc-100 rounded-xl p-1 mb-5 w-full">
              <button
                className={`flex-1 py-2.5 rounded-lg text-sm font-medium transition-all ${authMode === 'login' ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500 hover:text-zinc-700'}`}
                onClick={() => { setAuthMode('login'); setAuthError(''); }}
              >
                登录
              </button>
              <button
                className={`flex-1 py-2.5 rounded-lg text-sm font-medium transition-all ${authMode === 'register' ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500 hover:text-zinc-700'}`}
                onClick={() => { setAuthMode('register'); setAuthError(''); }}
              >
                注册账号
              </button>
            </div>

            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (authSubmitting) return;
                void submitAuth();
              }}
            >
              <div>
                <label htmlFor="auth-account" className="block text-sm font-medium text-zinc-700 mb-1.5">账号</label>
                <input
                  id="auth-account"
                  name="username"
                  type="text"
                  value={authAccount}
                  onChange={(e) => {
                    setAuthAccount(e.target.value.replace(/\D/g, '').slice(0, 12));
                    setAuthError('');
                  }}
                  placeholder="请输入8-12位数字账号"
                  autoComplete="username"
                  inputMode="numeric"
                  maxLength={12}
                  className="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-4 py-2.5 text-zinc-800 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-[#266eff]/30 focus:border-[#266eff] transition"
                />
                {authMode === 'register' && <p className="text-xs text-zinc-400 mt-1">账号为8-12位纯数字，注册后不可修改</p>}
              </div>

              <input
                type="text"
                name="username"
                autoComplete="username"
                value={authAccount}
                readOnly
                tabIndex={-1}
                aria-hidden="true"
                className="hidden"
              />

              <div>
                <label htmlFor="auth-password" className="block text-sm font-medium text-zinc-700 mb-1.5">密码</label>
                <div className="relative">
                  <input
                    id="auth-password"
                    name="password"
                    type={showAuthPassword ? 'text' : 'password'}
                    value={authPassword}
                    onChange={(e) => {
                      setAuthPassword(e.target.value);
                      setAuthError('');
                    }}
                    placeholder="8-20位，字母+数字组合"
                    autoComplete={authMode === 'register' ? 'new-password' : 'current-password'}
                    className="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-4 py-2.5 pr-10 text-zinc-800 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-[#266eff]/30 focus:border-[#266eff] transition"
                  />
                  <button type="button" onClick={() => setShowAuthPassword(!showAuthPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600">
                    {showAuthPassword ? (
                      <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                    ) : (
                      <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" /></svg>
                    )}
                  </button>
                </div>
                {authMode === 'register' && <p className="text-xs text-zinc-400 mt-1">8-20位，必须包含字母和数字</p>}
              </div>

              {authMode === 'register' && (
                <div>
                  <input
                    type="text"
                    name="username"
                    autoComplete="username"
                    value={authAccount}
                    readOnly
                    tabIndex={-1}
                    aria-hidden="true"
                    className="hidden"
                  />
                  <label htmlFor="auth-password-confirm" className="block text-sm font-medium text-zinc-700 mb-1.5">确认密码</label>
                  <div className="relative">
                    <input
                      id="auth-password-confirm"
                      name="password-confirm"
                      type={showAuthPasswordConfirm ? 'text' : 'password'}
                      value={authPasswordConfirm}
                      onChange={(e) => {
                        setAuthPasswordConfirm(e.target.value);
                        setAuthError('');
                      }}
                      placeholder="请再次输入密码"
                      autoComplete="new-password"
                      className="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-4 py-2.5 pr-10 text-zinc-800 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-[#266eff]/30 focus:border-[#266eff] transition"
                    />
                    <button type="button" onClick={() => setShowAuthPasswordConfirm(!showAuthPasswordConfirm)} className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600">
                      {showAuthPasswordConfirm ? (
                        <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                      ) : (
                        <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" /></svg>
                      )}
                    </button>
                  </div>
                  <p className="text-xs text-zinc-400 mt-1">请再次输入相同密码</p>
                </div>
              )}

              {authError ? (
                <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm text-rose-600 flex items-start gap-2">
                  <span className="mt-0.5 shrink-0">✕</span>
                  <span>{authError}</span>
                </div>
              ) : null}

              <button
                type="submit"
                disabled={authSubmitting}
                className="w-full py-3 rounded-xl bg-gradient-to-r from-[#266eff] to-[#a855f7] text-white font-semibold hover:opacity-90 disabled:opacity-60 transition shadow-md shadow-blue-200 mt-2"
              >
                {authSubmitting ? (
                  <span className="flex items-center justify-center gap-2">
                    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                    </svg>
                    处理中...
                  </span>
                ) : authMode === 'register' ? '注册并登录' : '登录'}
              </button>
            </form>

            {authMode === 'register' && (
              <p className="text-xs text-zinc-400 text-center mt-4">
                注册即表示同意平台服务条款，新用户赠送 <span className="text-[#266eff] font-medium">5积分</span>
              </p>
            )}
          </div>
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
            (() => {
              const cancelling = queueCancellingIds.has(q.id);
              const cancelLocked = queueCancelLockedIds.has(q.id);
              return (
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
                    disabled={cancelling || cancelLocked}
                    title={cancelLocked ? '后台已完成生成，不可取消' : undefined}
                    className={`text-xs text-zinc-700 px-2 py-1 rounded-lg border border-zinc-300 bg-white hover:bg-[#fff1f1] hover:text-rose-600 disabled:opacity-60 ${focusRingClass}`}
                  >
                    {cancelling ? '取消中...' : cancelLocked ? '已完成' : '取消'}
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-violet-500">处理中</span>
                  <button
                    onClick={() => cancelQueuedTask(q.id)}
                    disabled={cancelling || cancelLocked}
                    title={cancelLocked ? '后台已完成生成，不可取消' : undefined}
                    className={`text-xs text-zinc-700 px-2 py-1 rounded-lg border border-zinc-300 bg-white hover:bg-[#fff1f1] hover:text-rose-600 disabled:opacity-60 ${focusRingClass}`}
                  >
                    {cancelling ? '取消中...' : cancelLocked ? '已完成' : '取消'}
                  </button>
                </div>
              )}
            </div>
              );
            })()
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div className="h-screen overflow-hidden bg-[#f4f6fb] text-white flex">
      <Toaster position="top-center" richColors />

      {/* 左侧边栏 */}
      <div className="w-72 h-screen shrink-0 bg-white border-r border-zinc-200 p-6 flex flex-col text-zinc-800">
        <div className="flex items-center gap-3 mb-10">
          <img src="/kunkun-logo.webp" alt="坤坤 AI Logo" className="w-9 h-9 rounded-2xl object-cover" />
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
            <span>用户积分</span>
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

          <button
            onClick={() => setActiveView('referral')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl ${
              activeView === 'referral'
                ? 'bg-gradient-to-r from-[#dde9ff] to-[#f9efff] text-[#266eff] font-medium'
                : 'text-zinc-600 hover:bg-[#f0f3f7] hover:text-zinc-800'
            }`}
          >
            <Plus className="w-5 h-5" />
            <span>推广计划</span>
          </button>

          <button
            onClick={() => setActiveView('help')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl ${
              activeView === 'help'
                ? 'bg-gradient-to-r from-[#dde9ff] to-[#f9efff] text-[#266eff] font-medium'
                : 'text-zinc-600 hover:bg-[#f0f3f7] hover:text-zinc-800'
            }`}
          >
            <MessageCircle className="w-5 h-5" />
            <span>帮助与反馈</span>
          </button>
        </div>

      </div>

      {/* 主内容 */}
      <div className="flex-1 h-screen flex flex-col overflow-hidden">
        <div className="shrink-0 sticky top-0 z-30 bg-white border-b border-zinc-200 px-4 sm:px-6 lg:px-8 xl:px-10 py-3">
          <div className="flex items-center justify-between">
            <div className="text-sm text-zinc-600">📢 通知：{siteNoticeText}</div>
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

        <div className="flex-1 overflow-y-auto">
          <div className="max-w-[1720px] mx-auto px-4 sm:px-6 lg:px-8 xl:px-10 py-8 lg:py-10">
          {activeView === 'workflows' ? (
            <>
              <div className="text-center mb-10">
                <h1 className="text-4xl lg:text-[2.5rem] font-bold mb-3 text-zinc-900">专业级 AI 视觉，快速落地任何创意</h1>
                <p className="text-base lg:text-lg text-zinc-400">AI 驱动图像与视频生成，支持电商营销、品牌传播、内容创作等全场景高效交付。</p>
              </div>

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
                  (() => {
                    const disabledMeta = getWorkflowDisableMeta(wf.workflowId);
                    const disabled = Boolean(disabledMeta?.disabled);
                    return (
                  <Link
                    key={wf.id}
                    href={`/workflow-app/${wf.slug}`}
                    onClick={(e) => {
                      if (workflowCenterLocked) {
                        e.preventDefault();
                        toast.error('当前已临时禁用全部 AI 应用，请等待修复后再使用');
                        return;
                      }
                      if (disabled) {
                        e.preventDefault();
                        toast.error(`该应用已下架/维护中${disabledMeta?.reason ? `（${disabledMeta.reason}）` : ''}`);
                        return;
                      }
                      setNavigatingSlug(wf.slug);
                    }}
                    className={`card-item ${
                      workflowCenterLocked || disabled
                        ? 'opacity-50 cursor-not-allowed'
                        : 'cursor-pointer'
                    }`}
                    aria-disabled={workflowCenterLocked || disabled}
                  >
                    {disabled ? (
                      <div className="absolute left-3 top-3 z-10 text-[10px] px-2 py-0.5 rounded-full bg-zinc-900/80 border border-zinc-200/30 text-zinc-100">
                        已下架/维护中
                      </div>
                    ) : null}

                    <div className="relative">
                      <img
                        src={wf.coverImage || 'https://dundun2026.oss-cn-guangzhou.aliyuncs.com/waterfalls/20260326_e8d3f4780d11.jpg'}
                        alt={wf.title}
                        className="card-item-image"
                        loading="lazy"
                      />
                      <div className="card-title-overlay">
                        <div className="line-clamp-2">{wf.description}</div>
                      </div>
                    </div>
                  </Link>
                    );
                  })()
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
                      积分中心
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
                              前往积分中心
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
                                  usageRowsPaged.map((row) => (
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
                          {usageRowsInProfile.length > 0 && (
                            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                              <div className="text-xs text-zinc-500">
                                共 {usageRowsInProfile.length} 条，第 {usagePageSafe}/{usageTotalPages} 页
                              </div>
                              <div className="flex items-center gap-2">
                                <select
                                  value={usagePageSize}
                                  onChange={(e) => {
                                    const next = Number(e.target.value) || 20;
                                    setUsagePageSize(next);
                                    setUsagePage(1);
                                  }}
                                  className="h-8 rounded-lg border border-zinc-200 px-2 text-xs text-zinc-700 bg-white focus:outline-none focus:ring-0 focus:border-zinc-200 no-focus-ring-zinc"
                                >
                                  <option value={10}>10/页</option>
                                  <option value={20}>20/页</option>
                                  <option value={50}>50/页</option>
                                  <option value={100}>100/页</option>
                                </select>
                                <button
                                  onClick={() => setUsagePage((p) => Math.max(1, p - 1))}
                                  disabled={usagePageSafe <= 1}
                                  className="h-8 px-3 rounded-lg border border-zinc-200 text-xs text-zinc-700 bg-white disabled:opacity-50"
                                >
                                  上一页
                                </button>
                                {usagePageNumbers.map((page, index) =>
                                  page === 'ellipsis' ? (
                                    <span key={`usage-ellipsis-${index}`} className="px-1 text-xs text-zinc-400">...</span>
                                  ) : (
                                    <button
                                      key={`usage-page-${page}`}
                                      onClick={() => setUsagePage(page)}
                                      className={`h-8 min-w-8 px-2 rounded-lg border text-xs ${
                                        page === usagePageSafe
                                          ? 'bg-brand-gradient text-white border-transparent'
                                          : 'border-zinc-200 text-zinc-700 bg-white'
                                      }`}
                                    >
                                      {page}
                                    </button>
                                  )
                                )}
                                <button
                                  onClick={() => setUsagePage((p) => Math.min(usageTotalPages, p + 1))}
                                  disabled={usagePageSafe >= usageTotalPages}
                                  className="h-8 px-3 rounded-lg border border-zinc-200 text-xs text-zinc-700 bg-white disabled:opacity-50"
                                >
                                  下一页
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    {rechargeTab === 'points' && (
                      <div className="space-y-5">
                        <div className="text-center mb-2">
                          <div className="text-3xl font-semibold text-zinc-800">用户积分</div>
                          <div className="text-sm text-zinc-500 mt-2">基于产品的特殊性，本款产品完成支付后不支持退订，购买前仔细阅读产品权益。</div>
                        </div>

                        <div className="bg-white rounded-2xl p-7">
                          <div className="text-base font-semibold text-zinc-800 mb-4 border-l-4 border-[#266eff] pl-3">积分充值</div>

                          {pendingPayOrders.length > 0 ? (
                            <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-zinc-700">
                              <div className="font-medium text-zinc-800 mb-2">最近待支付订单</div>
                              <div className="space-y-2">
                                {pendingPayOrders.map((item) => {
                                  const expireAtMs = new Date(item.expireAt).getTime();
                                  const remain = Number.isNaN(expireAtMs) ? 0 : Math.max(0, Math.floor((expireAtMs - pendingPayTick) / 1000));
                                  return (
                                    <div key={item.orderNo} className="rounded-lg border border-amber-200 bg-white/70 px-3 py-2">
                                      <div>订单号：{item.orderNo}</div>
                                      <div>金额：￥{(item.amountFen / 100).toFixed(2)} · 渠道：{item.channel === 'wechat' ? '微信' : '支付宝'}</div>
                                      <div className="text-xs text-zinc-600 mt-1">剩余支付时间：{String(Math.floor(remain / 60)).padStart(2, '0')}:{String(remain % 60).padStart(2, '0')}</div>
                                      <div className="mt-2 flex gap-2">
                                        <button
                                          type="button"
                                          onClick={() => openPendingPayOrder(item.orderNo)}
                                          className="h-8 px-3 rounded-lg bg-white border border-zinc-200 text-zinc-700 hover:bg-zinc-50"
                                        >
                                          继续支付
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => closePendingPayOrder(item.orderNo)}
                                          disabled={closingPendingPayOrder}
                                          className="h-8 px-3 rounded-lg bg-white border border-zinc-200 text-zinc-700 hover:bg-zinc-50 disabled:opacity-60"
                                        >
                                          {closingPendingPayOrder ? '关闭中...' : '关闭此订单'}
                                        </button>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          ) : null}

                          <div className="mb-4">
                            <div className="flex flex-wrap gap-2">
                              {[10, 50, 100, 200].map((amount) => {
                                const active = selectedRechargePreset === amount;
                                return (
                                  <button
                                    key={amount}
                                    type="button"
                                    onClick={() => {
                                      setRechargeAmountInput(String(amount));
                                      setSelectedRechargePreset(amount);
                                    }}
                                    className={`h-12 px-5 rounded-xl text-base font-semibold border transition-colors ${
                                      active
                                        ? 'bg-brand-gradient text-white border-transparent'
                                        : 'bg-white text-zinc-700 border-zinc-200 hover:bg-zinc-50'
                                    }`}
                                  >
                                    ￥{amount}
                                  </button>
                                );
                              })}
                            </div>
                          </div>

                          <div className="mb-4">
                            <input
                              value={rechargeAmountInput}
                              onChange={(e) => {
                                setRechargeAmountInput(e.target.value.replace(/[^\d]/g, ''));
                                setSelectedRechargePreset(null);
                              }}
                              placeholder="请输入充值金额"
                              className="w-full h-11 rounded-xl border border-zinc-200 px-3 text-sm font-semibold text-zinc-800 outline-none focus:outline-none focus:ring-0 focus:border-zinc-200 no-focus-ring-zinc"
                            />
                            <div className="text-sm text-zinc-500 mt-2">（1 元 = 100 积分，最低 10 元，仅支持整数）</div>
                          </div>

                          <div className="mb-4">
                            <div className="text-base font-semibold text-zinc-800 mb-2">选择支付方式</div>
                            <div className="flex gap-2">
                              <button
                                type="button"
                                onClick={() => setRechargeChannel('wechat')}
                                className={`h-10 px-4 rounded-xl text-sm border ${rechargeChannel === 'wechat' ? 'bg-brand-gradient text-white border-transparent' : 'bg-white text-zinc-700 border-zinc-200 hover:bg-zinc-50'}`}
                              >
                                微信
                              </button>
                              <button
                                type="button"
                                onClick={() => setRechargeChannel('alipay')}
                                className={`h-10 px-4 rounded-xl text-sm border ${rechargeChannel === 'alipay' ? 'bg-brand-gradient text-white border-transparent' : 'bg-white text-zinc-700 border-zinc-200 hover:bg-zinc-50'}`}
                              >
                                支付宝
                              </button>
                            </div>
                          </div>

                          <button
                            type="button"
                            onClick={openRechargePayModal}
                            disabled={rechargeCooldownSeconds > 0}
                            className="h-11 px-8 rounded-xl bg-gradient-to-r from-[#dde9ff] to-[#f9efff] text-[#266eff] text-base font-semibold hover:brightness-95 transition"
                          >
                            {rechargeCooldownSeconds > 0 ? `${rechargeCooldownSeconds}秒后可重试` : '确认充值'}
                          </button>
                        </div>

                        <div className="bg-white rounded-2xl p-7">
                          <div className="space-y-3">
                            <input
                              value={redeemCodeInput}
                              onChange={(e) => setRedeemCodeInput(e.target.value)}
                              placeholder="请输入兑换码"
                              autoComplete="off"
                              className="w-full h-11 rounded-xl border border-zinc-200 px-3 text-sm text-zinc-800 outline-none focus:outline-none focus:ring-0 focus:border-zinc-200 no-focus-ring-zinc"
                            />
                            <button
                              onClick={redeemPointsByCode}
                              disabled={redeemSubmitting}
                              className="h-11 px-8 rounded-xl bg-gradient-to-r from-[#dde9ff] to-[#f9efff] text-[#266eff] text-base font-semibold hover:brightness-95 transition disabled:opacity-60"
                            >
                              {redeemSubmitting ? '兑换中...' : '立即兑换'}
                            </button>
                          </div>
                          <div className="text-sm text-zinc-500 mt-3">如果你还没有兑换码，请点击右下角“专属顾问”获取兑换码。</div>
                        </div>

                        <div className="bg-white rounded-2xl p-7">
                          <div className="text-base font-semibold text-zinc-800 mb-4 border-l-4 border-[#266eff] pl-3">积分记录</div>
                          {rechargeRecords.length === 0 ? (
                            <div className="py-8 text-center text-zinc-400">暂无积分记录</div>
                          ) : (
                            <div className="space-y-2">
                              {rechargeRecords.map((r) => (
                                <div
                                  key={r.id}
                                  className="flex items-center justify-between rounded-xl border border-zinc-200 bg-[#f8faff] px-4 py-3"
                                >
                                  <div className="text-zinc-700">兑换码：{r.codePreview}</div>
                                  <div className="text-zinc-700">获得积分：+{r.points}</div>
                                  <div className="text-zinc-500 text-xs">{formatTime(r.createdAt)}</div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                  </div>
                </div>
              </div>
            </>
          ) : activeView === 'referral' ? (
            <div className="bg-white rounded-2xl p-7 border border-zinc-200">
              <div className="text-base font-semibold text-zinc-800 mb-4 border-l-4 border-[#266eff] pl-3">推广计划</div>
              <div className="text-sm text-zinc-500">该功能暂未开放，敬请期待。</div>
            </div>
          ) : activeView === 'help' ? (
            <div className="bg-white rounded-2xl p-7 border border-zinc-200">
              <div className="text-base font-semibold text-zinc-800 mb-4 border-l-4 border-[#266eff] pl-3">帮助与反馈</div>
              <p className="text-zinc-600">如需帮助，请点击右下角“专属顾问”联系人工支持。</p>
              <div className="mt-4 rounded-xl border border-zinc-200 bg-[#f8faff] p-4 text-sm text-zinc-600 space-y-1">
                <div className="font-medium text-zinc-700">隐私与保存期限说明</div>
                <div>生成内容历史：默认保留15天。</div>
                <div>积分消费记录：保留15天。</div>
                <div>积分记录：保留1年。</div>
              </div>
            </div>
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
                    <div className="flex items-center gap-3">
                      <span>已选 {selectedHistoryIds.length} 条</span>
                      <span>共 {filteredHistory.length} 条，第 {historyPageSafe}/{historyTotalPages} 页</span>
                    </div>
                  </div>
                  {pagedHistory.map((item) => {
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
                  <div className="flex items-center justify-end gap-2 pt-2">
                    <select
                      value={historyPageSize}
                      onChange={(e) => {
                        const next = Number(e.target.value) || 20;
                        setHistoryPageSize(next);
                        setHistoryPage(1);
                      }}
                      className="h-8 rounded-lg border border-zinc-200 px-2 text-xs text-zinc-700 bg-white focus:outline-none focus:ring-0 focus:border-zinc-200 no-focus-ring-zinc"
                    >
                      <option value={10}>10/页</option>
                      <option value={20}>20/页</option>
                      <option value={50}>50/页</option>
                      <option value={100}>100/页</option>
                    </select>
                    <button
                      onClick={() => setHistoryPage((p) => Math.max(1, p - 1))}
                      disabled={historyPageSafe <= 1}
                      className="h-8 px-3 rounded-lg border border-zinc-200 text-xs text-zinc-700 bg-white disabled:opacity-50 focus:outline-none"
                    >
                      上一页
                    </button>
                    {historyPageNumbers.map((page, index) =>
                      page === 'ellipsis' ? (
                        <span key={`history-ellipsis-${index}`} className="px-1 text-xs text-zinc-400">...</span>
                      ) : (
                        <button
                          key={`history-page-${page}`}
                          onClick={() => setHistoryPage(page)}
                          className={`h-8 min-w-8 px-2 rounded-lg border text-xs ${
                            page === historyPageSafe
                              ? 'bg-brand-gradient text-white border-transparent'
                              : 'border-zinc-200 text-zinc-700 bg-white'
                          } focus:outline-none`}
                        >
                          {page}
                        </button>
                      )
                    )}
                    <button
                      onClick={() => setHistoryPage((p) => Math.min(historyTotalPages, p + 1))}
                      disabled={historyPageSafe >= historyTotalPages}
                      className="h-8 px-3 rounded-lg border border-zinc-200 text-xs text-zinc-700 bg-white disabled:opacity-50 focus:outline-none"
                    >
                      下一页
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
          </div>
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
                className="w-full h-11 bg-[#f5f7fa] border border-zinc-200 rounded-xl px-3 text-zinc-800 no-focus-ring"
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
              <div className="relative">
                <input
                  type={showPasswordCurrent ? 'text' : 'password'}
                  value={passwordCurrent}
                  onChange={(e) => setPasswordCurrent(e.target.value)}
                  className="w-full h-11 bg-[#f5f7fa] border border-zinc-200 rounded-xl px-3 pr-10 text-zinc-800 no-focus-ring"
                  placeholder="当前密码"
                />
                <button type="button" onClick={() => setShowPasswordCurrent(!showPasswordCurrent)} className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600">
                  {showPasswordCurrent ? (
                    <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                  ) : (
                    <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" /></svg>
                  )}
                </button>
              </div>
              <div className="relative">
                <input
                  type={showPasswordNext ? 'text' : 'password'}
                  value={passwordNext}
                  onChange={(e) => setPasswordNext(e.target.value)}
                  className="w-full h-11 bg-[#f5f7fa] border border-zinc-200 rounded-xl px-3 pr-10 text-zinc-800 no-focus-ring"
                  placeholder="新密码（8-20位字母+数字）"
                />
                <button type="button" onClick={() => setShowPasswordNext(!showPasswordNext)} className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600">
                  {showPasswordNext ? (
                    <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                  ) : (
                    <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" /></svg>
                  )}
                </button>
              </div>
              <div className="relative">
                <input
                  type={showPasswordConfirm ? 'text' : 'password'}
                  value={passwordConfirm}
                  onChange={(e) => setPasswordConfirm(e.target.value)}
                  className="w-full h-11 bg-[#f5f7fa] border border-zinc-200 rounded-xl px-3 pr-10 text-zinc-800 no-focus-ring"
                  placeholder="确认新密码"
                />
                <button type="button" onClick={() => setShowPasswordConfirm(!showPasswordConfirm)} className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600">
                  {showPasswordConfirm ? (
                    <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                  ) : (
                    <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" /></svg>
                  )}
                </button>
              </div>
              <p className="text-xs text-zinc-400 mt-1">新密码需8-20位，包含字母和数字；并与确认密码一致</p>
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
        ref={advisorButtonRef}
        onClick={() => {
          if (advisorSuppressClickRef.current) {
            advisorSuppressClickRef.current = false;
            return;
          }
          setShowAdvisorModal(true);
        }}
        onMouseDown={(e) => startAdvisorPress(e.clientX, e.clientY)}
        onTouchStart={(e) => {
          const touch = e.touches[0];
          if (!touch) return;
          startAdvisorPress(touch.clientX, touch.clientY);
        }}
        style={advisorPosition ? { left: `${advisorPosition.x}px`, top: `${advisorPosition.y}px` } : undefined}
        className={`fixed z-40 w-20 h-20 rounded-full bg-gradient-to-br from-sky-500 to-violet-500 shadow-xl shadow-violet-400/30 flex flex-col items-center justify-center text-white transition ${advisorPosition ? '' : 'right-8 bottom-8'} ${isDraggingAdvisor ? 'cursor-grabbing' : 'cursor-grab hover:translate-y-[-2px]'}`}
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

        .no-focus-ring-zinc:focus-visible {
          box-shadow: none !important;
          border-color: rgb(228 228 231) !important;
        }
      `}</style>
    </div>
  );
}
