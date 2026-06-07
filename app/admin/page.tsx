'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Toaster, toast } from 'sonner';
import { workflows, type Workflow } from '@/lib/workflows';

type DisabledWorkflow = {
  workflowId: string;
  disabled: boolean;
  reason: string;
  disabledAt: string;
};

type AdminUser = {
  id: string;
  account: string;
  username: string;
  role: 'user' | 'admin';
  points: number;
  taskBlocked: boolean;
  createdAt: string;
  updatedAt: string;
};

type AuthUser = {
  id: string;
  account: string;
  username: string;
  role: 'user' | 'admin';
  points: number;
  taskBlocked: boolean;
};

type UserPointLog = {
  id: string;
  delta: number;
  reason: string;
  relatedId: string | null;
  balanceAfter: number;
  createdAt: string;
};

type UserOrder = {
  id: string;
  orderNo: string;
  channel: string;
  amountFen: number;
  points: number;
  status: string;
  gatewayStatus: string | null;
  thirdTradeNo: string | null;
  paidAmountFen: number | null;
  paidAt: string | null;
  refundNo: string | null;
  refundAmountFen: number | null;
  refundStatus: string | null;
  refundedAt: string | null;
  createdAt: string;
};

type UserSecurityEvent = {
  id: string;
  type: string;
  detail: string;
  ip?: string;
  route?: string;
  createdAt: number;
};

type SecurityAuditEvent = {
  id: string;
  path: string;
  action: string;
  result: 'success' | 'rejected' | 'failed';
  status: number;
  requestId?: string;
  createdAt: number;
};

type AdminTaskRow = {
  id: string;
  requestId: string;
  workflowId: string;
  workflowTitle: string;
  status: string;
  taskId: string | null;
  pointsCost: number;
  resultUrl: string | null;
  resultType: string | null;
  error: string | null;
  deliveryStatus: string;
  deliveryAttempts: number;
  deliveryLastError: string | null;
  deliveryAckAt: string | null;
  hiddenAt: string | null;
  createdAt: string;
  user: {
    id: string;
    account: string;
    username: string;
  };
};

type AdminTaskStats = {
  total: number;
  success: number;
  failed: number;
  deliveryFailed: number;
  successRate: number;
  statusGroups: Array<{ status: string; count: number }>;
  topUsers: Array<{ account: string; count: number }>;
};

type QueueConfig = {
  timeoutDefaults: {
    imageMs: number;
    audioMs: number;
    videoMs: number;
  };
  workflowTimeoutOverrides: Record<string, number>;
  heartbeatToleranceMs: number;
  refundPolicy: {
    submitFailed: 'full' | 'none';
    taskFailed: 'full' | 'none';
    taskTimeout: 'full' | 'none';
    payloadInvalid: 'full' | 'none';
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
    workflowProfiles: Record<string, {
      runtimeSeconds: number;
      extraCostYuan: number;
      extraCostRhCoins: number;
      instanceType: 'lite' | 'default' | 'plus';
      grossMarginPercent: number;
    }>;
  };
};

type QueueConcurrencyRuntime = {
  effectiveLimit: number;
  currentLimit: number;
  lastScaledAt: number;
  lastSignal: 'init' | 'throttle' | 'success_batch';
  enabled: boolean;
};

type RedeemCodeRow = {
  id: string;
  codePreview: string;
  mode: 'universal' | 'bound';
  points: number;
  amountFen: number | null;
  exchangeRate: number;
  maxUses: number;
  usedCount: number;
  status: 'active' | 'used' | 'expired' | 'revoked';
  expiresAt: string | null;
  usedAt: string | null;
  note: string | null;
  createdAt: string;
  boundUser: { id: string; account: string; username: string } | null;
  usedByUser: { id: string; account: string; username: string } | null;
  createdByUser: { id: string; account: string; username: string };
};

type AdminSection = 'system' | 'pricing' | 'workflow-cost' | 'users' | 'tasks' | 'redeem';
type UserTaskStatusFilter = 'all' | 'blocked' | 'normal';

export default function AdminPage() {
  const [loading, setLoading] = useState(true);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [verified, setVerified] = useState(false);

  const [globalStopEnabled, setGlobalStopEnabled] = useState(false);
  const [siteNoticeText, setSiteNoticeText] = useState('');
  const [siteNoticeUpdatedAt, setSiteNoticeUpdatedAt] = useState<string | null>(null);
  const [siteNoticeSaving, setSiteNoticeSaving] = useState(false);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [userFilteredTotal, setUserFilteredTotal] = useState(0);
  const [userAllTotal, setUserAllTotal] = useState(0);
  const [keyword, setKeyword] = useState('');
  const [userTaskStatusFilter, setUserTaskStatusFilter] = useState<UserTaskStatusFilter>('all');
  const [userLoading, setUserLoading] = useState(false);

  const [selectedUserId, setSelectedUserId] = useState('');
  const [deltaInput, setDeltaInput] = useState('');
  const [reasonInput, setReasonInput] = useState('');
  const [selectedUserLogs, setSelectedUserLogs] = useState<UserPointLog[]>([]);
  const [selectedUserOrders, setSelectedUserOrders] = useState<UserOrder[]>([]);
  const [selectedUserSecurityEvents, setSelectedUserSecurityEvents] = useState<UserSecurityEvent[]>([]);
  const [unknownStatusAudits, setUnknownStatusAudits] = useState<SecurityAuditEvent[]>([]);
  const [unknownStatusAuditsLoading, setUnknownStatusAuditsLoading] = useState(false);
  const [unknownStatusCodeFilter, setUnknownStatusCodeFilter] = useState<'all' | number>('all');
  const [taskStatusFilter, setTaskStatusFilter] = useState('');
  const [taskAccountFilter, setTaskAccountFilter] = useState('');
  const [taskKeywordFilter, setTaskKeywordFilter] = useState('');
  const [taskAnomalyOnly, setTaskAnomalyOnly] = useState(true);
  const [taskAnomalyType, setTaskAnomalyType] = useState('');
  const [taskFrom, setTaskFrom] = useState('');
  const [taskTo, setTaskTo] = useState('');
  const [taskIncludeHidden, setTaskIncludeHidden] = useState(false);
  const [taskRows, setTaskRows] = useState<AdminTaskRow[]>([]);
  const [taskStats, setTaskStats] = useState<AdminTaskStats | null>(null);
  const [taskLoading, setTaskLoading] = useState(false);
  const [queueConfig, setQueueConfig] = useState<QueueConfig | null>(null);
  const [queueRuntime, setQueueRuntime] = useState<QueueConcurrencyRuntime | null>(null);
  const [queueConfigLoading, setQueueConfigLoading] = useState(false);
  const [workflowPrechargeSyncedAt, setWorkflowPrechargeSyncedAt] = useState<number | null>(null);
  const [workflowPrechargeSyncing, setWorkflowPrechargeSyncing] = useState(false);
  const [adminSection, setAdminSection] = useState<AdminSection>('system');
  const [disabledWorkflows, setDisabledWorkflows] = useState<DisabledWorkflow[]>([]);
  const [workflowToggling, setWorkflowToggling] = useState<Record<string, boolean>>({});
  const [selectedWorkflowIds, setSelectedWorkflowIds] = useState<Set<string>>(new Set());
  const [redeemCodeRows, setRedeemCodeRows] = useState<RedeemCodeRow[]>([]);
  const [redeemCodeLoading, setRedeemCodeLoading] = useState(false);
  const [redeemCreateMode, setRedeemCreateMode] = useState<'universal' | 'bound'>('universal');
  const [redeemBoundUserId, setRedeemBoundUserId] = useState('');
  const [redeemBindKeyword, setRedeemBindKeyword] = useState('');
  const [redeemBindUserResults, setRedeemBindUserResults] = useState<AdminUser[]>([]);
  const [redeemBindLoading, setRedeemBindLoading] = useState(false);
  const [redeemPointsInput, setRedeemPointsInput] = useState('1000');
  const [redeemValidDaysInput, setRedeemValidDaysInput] = useState('3');
  const [redeemValidityMode, setRedeemValidityMode] = useState<'preset' | 'custom'>('preset');
  const [redeemValidityPreset, setRedeemValidityPreset] = useState<'1' | '3' | '7' | '30' | '0'>('3');
  const [redeemNote, setRedeemNote] = useState('');
  const [latestPlainRedeemCode, setLatestPlainRedeemCode] = useState('');
  const [redeemMaxUsesInput, setRedeemMaxUsesInput] = useState('1');
  const [redeemRowMaxUses, setRedeemRowMaxUses] = useState<Record<string, string>>({});
  const [redeemStatusFilter, setRedeemStatusFilter] = useState<'all' | 'active' | 'used' | 'expired' | 'revoked'>('all');
  const [redeemModeFilter, setRedeemModeFilter] = useState<'all' | 'universal' | 'bound'>('all');
  const [pricingCalculatorCostYuan, setPricingCalculatorCostYuan] = useState('0.10');

  const buttonPrimaryClass = 'h-9 px-3 rounded-xl bg-zinc-900 text-white hover:bg-zinc-800 text-sm disabled:opacity-40';
  const buttonDangerClass = 'h-9 px-3 rounded-xl bg-rose-600 text-white hover:bg-rose-700 text-sm disabled:opacity-40';
  const buttonSecondaryClass = 'h-9 px-3 rounded-xl border border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50 text-sm disabled:opacity-40';

  const formatGrossMargin = (multiplier: number) => {
    const n = Number(multiplier);
    if (!Number.isFinite(n) || n <= 0) return '--';
    const margin = (1 - 1 / n) * 100;
    return `${margin.toFixed(1)}%`;
  };

  const grossMarginToneClass = (multiplier: number) => {
    const n = Number(multiplier);
    if (!Number.isFinite(n) || n <= 0) return 'text-zinc-400';
    const margin = (1 - 1 / n) * 100;
    if (margin < 75) return 'text-amber-600';
    if (margin > 80) return 'text-rose-600';
    return 'text-emerald-600';
  };

  const estimateChargePoints = useCallback((costYuan: number, multiplier: number) => {
    if (!queueConfig) return 0;
    const safeCost = Math.max(0, Number(costYuan || 0));
    const safeFactor = Math.max(1, Number(queueConfig.pricing.cancelRunningSafetyFactor || 1));
    const minCharge = Math.max(0, Math.floor(Number(queueConfig.pricing.cancelRunningMinChargePoints || 0)));
    const m = Math.max(0, Number(multiplier || 0));
    const costPoints = Math.ceil(safeCost * 100 * safeFactor);
    return Math.max(minCharge, Math.ceil(costPoints * m));
  }, [queueConfig]);

  const grossMarginPercentToMultiplier = (marginPercent: number) => {
    const m = Math.min(99, Math.max(0, Number(marginPercent || 0)));
    const ratio = 1 - m / 100;
    if (ratio <= 0) return 0;
    return 1 / ratio;
  };

  const workflowCostRows = useMemo(() => {
    if (!queueConfig) return [] as Array<{
      workflow: Workflow;
      profile: QueueConfig['pricing']['workflowProfiles'][string];
      rhCostYuan: number;
      rmbCostYuan: number;
      serverCostYuan: number;
      totalCostYuan: number;
      prechargePoints: number;
    }>;

    return workflows.map((workflow) => {
      const profile = queueConfig.pricing.workflowProfiles?.[workflow.workflowId] || {
        runtimeSeconds: Math.max(0, Number(workflow.runtimeSeconds || 0)),
        extraCostYuan: Math.max(0, Number(workflow.extraCostYuan || 0)),
        extraCostRhCoins: Math.max(0, Number(workflow.extraCostRhCoins || 0)),
        instanceType: workflow.mediaType === 'video' ? 'plus' : 'lite',
        grossMarginPercent: Math.max(0, Number(queueConfig.pricing.defaultGrossMarginPercent || 0)),
      };

      const rhRate = Math.max(0, Number(queueConfig.pricing.rhCoinToYuan || 0));
      const instanceHourly =
        profile.instanceType === 'default'
          ? Math.max(0, Number(queueConfig.pricing.instanceHourlyCost.default || 0))
          : profile.instanceType === 'plus'
            ? Math.max(0, Number(queueConfig.pricing.instanceHourlyCost.plus || 0))
            : Math.max(0, Number(queueConfig.pricing.instanceHourlyCost.lite || 0));

      const rhCostYuan = Math.max(0, Number(profile.extraCostRhCoins || 0)) * rhRate;
      const rmbCostYuan = Math.max(0, Number(profile.extraCostYuan || 0));
      const serverCostYuan = (Math.max(0, Number(profile.runtimeSeconds || 0)) / 3600) * instanceHourly;
      const totalCostYuan = rhCostYuan + rmbCostYuan + serverCostYuan;
      const multiplier = grossMarginPercentToMultiplier(profile.grossMarginPercent);
      const prechargePoints = estimateChargePoints(totalCostYuan, multiplier);

      return {
        workflow,
        profile,
        rhCostYuan,
        rmbCostYuan,
        serverCostYuan,
        totalCostYuan,
        prechargePoints,
      };
    });
  }, [estimateChargePoints, queueConfig]);

  const unknownStatusCodeOptions = useMemo(() => {
    const set = new Set<number>();
    for (const item of unknownStatusAudits) {
      const n = Number(item.status);
      if (Number.isFinite(n)) {
        set.add(Math.floor(n));
      }
    }
    return Array.from(set).sort((a, b) => a - b);
  }, [unknownStatusAudits]);

  const filteredUnknownStatusAudits = useMemo(() => {
    if (unknownStatusCodeFilter === 'all') return unknownStatusAudits;
    return unknownStatusAudits.filter((item) => Number(item.status) === unknownStatusCodeFilter);
  }, [unknownStatusAudits, unknownStatusCodeFilter]);

  const updateWorkflowProfile = (
    workflowId: string,
    updater: (prev: QueueConfig['pricing']['workflowProfiles'][string]) => QueueConfig['pricing']['workflowProfiles'][string]
  ) => {
    setQueueConfig((prev) => {
      if (!prev) return prev;
      const currentProfile = prev.pricing.workflowProfiles?.[workflowId] || {
        runtimeSeconds: 0,
        extraCostYuan: 0,
        extraCostRhCoins: 0,
        instanceType: 'lite' as const,
        grossMarginPercent: Math.max(0, Number(prev.pricing.defaultGrossMarginPercent || 0)),
      };
      return {
        ...prev,
        pricing: {
          ...prev.pricing,
          workflowProfiles: {
            ...prev.pricing.workflowProfiles,
            [workflowId]: updater(currentProfile),
          },
        },
      };
    });
  };

  const selectedUser = useMemo(
    () => users.find((user) => user.id === selectedUserId) || null,
    [users, selectedUserId]
  );

  const blockedUserCount = useMemo(
    () => users.filter((item) => item.taskBlocked).length,
    [users]
  );

  const normalUserCount = useMemo(
    () => users.filter((item) => !item.taskBlocked).length,
    [users]
  );

  const verifyAdmin = async () => {
    const response = await fetch('/api/admin/verify', { method: 'POST' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data?.success) {
      throw new Error(data?.message || '无管理员权限');
    }
  };

  const fetchGlobalStop = async () => {
    const response = await fetch('/api/admin/system/global-stop', { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (response.ok && data?.success) {
      setGlobalStopEnabled(Boolean(data.data?.enabled));
    }
  };

  const fetchUsers = useCallback(async (search: string, status: UserTaskStatusFilter = userTaskStatusFilter) => {
    setUserLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('keyword', search);
      params.set('page', '1');
      params.set('pageSize', '50');
      params.set('taskStatus', status);
      const response = await fetch(
        `/api/admin/users?${params.toString()}`,
        { cache: 'no-store' }
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.success) {
        toast.error(data?.message || '查询用户失败');
        return;
      }

      const list: AdminUser[] = Array.isArray(data.data?.users) ? data.data.users : [];
      const total = Number(data.data?.total || 0);
      setUsers(list);
      setUserFilteredTotal(total);
      if (!search.trim() && status === 'all') {
        setUserAllTotal(total);
      }

      if (list.length > 0 && !list.some((u) => u.id === selectedUserId)) {
        setSelectedUserId(list[0].id);
      }
      if (list.length === 0) {
        setSelectedUserId('');
      }
    } finally {
      setUserLoading(false);
    }
  }, [selectedUserId, userTaskStatusFilter]);

  const fetchSelectedUserSummary = async (userId: string) => {
    if (!userId) {
      setSelectedUserLogs([]);
      setSelectedUserOrders([]);
      setSelectedUserSecurityEvents([]);
      return;
    }

    const response = await fetch(`/api/admin/users/${userId}/summary`, { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data?.success) {
      toast.error(data?.message || '读取用户详情失败');
      return;
    }

    setSelectedUserLogs(Array.isArray(data.data?.pointLogs) ? data.data.pointLogs : []);
    setSelectedUserOrders(Array.isArray(data.data?.orders) ? data.data.orders : []);
    setSelectedUserSecurityEvents(Array.isArray(data.data?.securityEvents) ? data.data.securityEvents : []);
  };

  const fetchTaskStats = useCallback(async () => {
    const response = await fetch('/api/admin/tasks/stats', { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data?.success) {
      toast.error(data?.message || '读取任务统计失败');
      return;
    }
    setTaskStats(data.data as AdminTaskStats);
  }, []);

  const fetchQueueConfig = useCallback(async () => {
    setQueueConfigLoading(true);
    try {
      const response = await fetch('/api/admin/system/queue-config', { cache: 'no-store' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.success) {
        toast.error(data?.message || '读取队列配置失败');
        return;
      }
      setQueueConfig((data.data?.config || data.data) as QueueConfig);
      setQueueRuntime((data.data?.runtime || null) as QueueConcurrencyRuntime | null);
    } finally {
      setQueueConfigLoading(false);
    }
  }, []);

  const fetchUnknownStatusAudits = useCallback(async () => {
    setUnknownStatusAuditsLoading(true);
    try {
      const response = await fetch('/api/admin/system/security-audit?action=runninghub_unknown_status&limit=30', {
        cache: 'no-store',
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.success) {
        toast.error(data?.message || '读取未知状态码告警失败');
        return;
      }
      setUnknownStatusAudits(Array.isArray(data.data) ? data.data : []);
    } finally {
      setUnknownStatusAuditsLoading(false);
    }
  }, []);

  const fetchWorkflowPrechargeSyncStatus = useCallback(async () => {
    try {
      const response = await fetch('/api/admin/system/workflow-precharge-sync', { cache: 'no-store' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.success) return;
      const syncedAt = Number(data?.data?.syncedAt || 0);
      setWorkflowPrechargeSyncedAt(Number.isFinite(syncedAt) && syncedAt > 0 ? syncedAt : null);
    } catch {
      // ignore
    }
  }, []);

  const syncWorkflowPrechargePoints = async () => {
    setWorkflowPrechargeSyncing(true);
    try {
      const response = await fetch('/api/admin/system/workflow-precharge-sync', {
        method: 'POST',
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.success) {
        toast.error(data?.message || '同步预占积分失败');
        return;
      }
      const syncedAt = Number(data?.data?.syncedAt || Date.now());
      setWorkflowPrechargeSyncedAt(Number.isFinite(syncedAt) && syncedAt > 0 ? syncedAt : Date.now());
      toast.success(`同步完成：${Number(data?.data?.workflowCount || 0)} 个 workflow 已生效`);
    } finally {
      setWorkflowPrechargeSyncing(false);
    }
  };

  const saveQueueConfig = async () => {
    if (!queueConfig) return;
    const payload: QueueConfig = {
      ...queueConfig,
      concurrency: {
        ...queueConfig.concurrency,
        minLimit: 40,
        maxLimit: 90,
        scaleDownStep: 5,
        scaleUpStep: 2,
        scaleUpCoolDownMs: 120 * 1000,
      },
    };
    const response = await fetch('/api/admin/system/queue-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data?.success) {
      toast.error(data?.message || '保存队列配置失败');
      return;
    }
    setQueueConfig((data.data?.config || data.data) as QueueConfig);
    setQueueRuntime((data.data?.runtime || null) as QueueConcurrencyRuntime | null);
    toast.success('队列配置已保存');
  };

  const fetchSiteNotice = useCallback(async () => {
    const response = await fetch('/api/admin/system/notice', { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data?.success) {
      toast.error(data?.message || '读取通知文案失败');
      return;
    }
    setSiteNoticeText(String(data?.data?.text || ''));
    setSiteNoticeUpdatedAt(data?.data?.updatedAt || null);
  }, []);

  const saveSiteNotice = async () => {
    const text = siteNoticeText.trim();
    if (!text) {
      toast.error('通知文案不能为空');
      return;
    }
    setSiteNoticeSaving(true);
    try {
      const response = await fetch('/api/admin/system/notice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.success) {
        toast.error(data?.message || '保存通知文案失败');
        return;
      }
      setSiteNoticeUpdatedAt(data?.data?.updatedAt || null);
      toast.success('通知文案已保存');
    } finally {
      setSiteNoticeSaving(false);
    }
  };

  const fetchDisabledWorkflows = useCallback(async () => {
    const response = await fetch('/api/admin/workflows/disabled', { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (response.ok && data?.success) {
      setDisabledWorkflows(Array.isArray(data.data) ? data.data : []);
    }
  }, []);

  const fetchRedeemCodes = useCallback(async (
    filters?: {
      status?: 'all' | 'active' | 'used' | 'expired' | 'revoked';
      mode?: 'all' | 'universal' | 'bound';
    }
  ) => {
    setRedeemCodeLoading(true);
    try {
      const status = filters?.status ?? redeemStatusFilter;
      const mode = filters?.mode ?? redeemModeFilter;
      const params = new URLSearchParams();
      params.set('page', '1');
      params.set('pageSize', '80');
      if (status !== 'all') params.set('status', status);
      if (mode !== 'all') params.set('mode', mode);
      const response = await fetch(`/api/admin/redeem-codes?${params.toString()}`, { cache: 'no-store' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.success) {
        toast.error(data?.message || '读取兑换码列表失败');
        return;
      }
      setRedeemCodeRows(Array.isArray(data.data?.rows) ? data.data.rows : []);
    } finally {
      setRedeemCodeLoading(false);
    }
  }, [redeemModeFilter, redeemStatusFilter]);

  const searchRedeemBindUsers = useCallback(async (keyword: string) => {
    const search = keyword.trim();
    if (!search) {
      setRedeemBindUserResults([]);
      return;
    }

    setRedeemBindLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('keyword', search);
      params.set('page', '1');
      params.set('pageSize', '20');
      params.set('taskStatus', 'all');
      const response = await fetch(`/api/admin/users?${params.toString()}`, { cache: 'no-store' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.success) {
        toast.error(data?.message || '用户搜索失败');
        return;
      }
      const list: AdminUser[] = Array.isArray(data.data?.users) ? data.data.users : [];
      setRedeemBindUserResults(list);
    } finally {
      setRedeemBindLoading(false);
    }
  }, []);

  const createRedeemCode = async () => {
    const points = Math.floor(Number(redeemPointsInput || 0));
    if (!Number.isFinite(points) || points <= 0) {
      toast.error('请输入大于0的积分值');
      return;
    }

    const maxUsesInput = Math.floor(Number(redeemMaxUsesInput || 1));
    const maxUses = redeemCreateMode === 'bound' ? 1 : Math.max(1, maxUsesInput);
    const validDaysRaw = redeemValidityMode === 'preset' ? redeemValidityPreset : redeemValidDaysInput;
    const validDays = Math.max(0, Math.floor(Number(validDaysRaw || 0)));

    if (redeemCreateMode === 'bound' && !redeemBoundUserId) {
      toast.error('专属码请先选择绑定用户');
      return;
    }

    const response = await fetch('/api/admin/redeem-codes/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: redeemCreateMode,
        boundUserId: redeemCreateMode === 'bound' ? redeemBoundUserId : null,
        points,
        maxUses,
        expiresInDays: validDays,
        note: redeemNote,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data?.success) {
      toast.error(data?.message || '创建兑换码失败');
      return;
    }

    const plainCode = String(data.data?.plainCode || '');
    setLatestPlainRedeemCode(plainCode);
    if (plainCode) {
      await navigator.clipboard.writeText(plainCode).catch(() => undefined);
    }
    toast.success(plainCode ? '兑换码已生成并复制到剪贴板' : '兑换码已生成');

    setRedeemBoundUserId('');
    setRedeemBindKeyword('');
    setRedeemBindUserResults([]);
    setRedeemNote('');
    setRedeemMaxUsesInput('1');
    setRedeemValidDaysInput('3');
    setRedeemValidityMode('preset');
    setRedeemValidityPreset('3');
    await fetchRedeemCodes();
  };

  const updateRedeemCodeUsageLimit = async (row: RedeemCodeRow) => {
    const raw = redeemRowMaxUses[row.id] ?? String(row.maxUses);
    const maxUses = Math.floor(Number(raw || 0));
    if (!Number.isFinite(maxUses) || maxUses <= 0) {
      toast.error('可使用次数必须大于0');
      return;
    }

    const response = await fetch('/api/admin/redeem-codes/update-usage-limit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: row.id, maxUses }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data?.success) {
      toast.error(data?.message || '更新可使用次数失败');
      return;
    }

    toast.success('可使用次数已更新');
    await fetchRedeemCodes();
  };

  const selectedRedeemBoundUser = useMemo(
    () => redeemBindUserResults.find((item) => item.id === redeemBoundUserId) || users.find((item) => item.id === redeemBoundUserId) || null,
    [redeemBindUserResults, redeemBoundUserId, users]
  );

  const revokeRedeemCode = async (id: string) => {
    const response = await fetch('/api/admin/redeem-codes/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data?.success) {
      toast.error(data?.message || '撤销兑换码失败');
      return;
    }
    toast.success('兑换码已撤销');
    await fetchRedeemCodes();
  };

  const toggleWorkflow = async (workflowId: string, action: 'enable' | 'disable') => {
    setWorkflowToggling((prev) => ({ ...prev, [workflowId]: true }));
    try {
      const response = await fetch('/api/admin/workflows/disabled', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflowId, action, reason: action === 'disable' ? '管理员手动禁用' : '' }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.success) {
        toast.error(data?.message || '操作失败');
        return;
      }
      await fetchDisabledWorkflows();
      toast.success(action === 'disable' ? '已禁用该AI应用' : '已重新启用该AI应用');
    } finally {
      setWorkflowToggling((prev) => ({ ...prev, [workflowId]: false }));
    }
  };

  const toggleSelectedWorkflows = async (action: 'enable' | 'disable') => {
    if (selectedWorkflowIds.size === 0) {
      toast.error('请先勾选要操作的AI应用');
      return;
    }
    for (const workflowId of selectedWorkflowIds) {
      await toggleWorkflow(workflowId, action);
    }
    setSelectedWorkflowIds(new Set());
  };

  const fetchTasks = useCallback(async (filters?: {
    status?: string;
    account?: string;
    keyword?: string;
    anomalyOnly?: boolean;
    anomalyType?: string;
    from?: string;
    to?: string;
    includeHidden?: boolean;
  }) => {
    setTaskLoading(true);
    try {
      const params = new URLSearchParams();
      const status = filters?.status ?? taskStatusFilter;
      const account = filters?.account ?? taskAccountFilter;
      const keyword = filters?.keyword ?? taskKeywordFilter;
      const anomalyOnly = filters?.anomalyOnly ?? taskAnomalyOnly;
      const anomalyType = filters?.anomalyType ?? taskAnomalyType;
      const from = filters?.from ?? taskFrom;
      const to = filters?.to ?? taskTo;
      const includeHidden = filters?.includeHidden ?? taskIncludeHidden;
      if (status) params.set('status', status);
      if (account) params.set('account', account);
      if (keyword) params.set('keyword', keyword);
      if (anomalyOnly) params.set('anomalyOnly', '1');
      if (anomalyOnly && anomalyType) params.set('anomalyType', anomalyType);
      if (includeHidden) params.set('includeHidden', '1');
      if (from) {
        const ts = new Date(from).getTime();
        if (Number.isFinite(ts)) params.set('from', String(ts));
      }
      if (to) {
        const ts = new Date(to).getTime();
        if (Number.isFinite(ts)) params.set('to', String(ts));
      }
      params.set('page', '1');
      params.set('pageSize', '80');

      const response = await fetch(`/api/admin/tasks?${params.toString()}`, { cache: 'no-store' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.success) {
        toast.error(data?.message || '查询任务失败');
        return;
      }

      setTaskRows(Array.isArray(data.data?.rows) ? (data.data.rows as AdminTaskRow[]) : []);
    } finally {
      setTaskLoading(false);
    }
  }, [taskAccountFilter, taskAnomalyOnly, taskAnomalyType, taskFrom, taskIncludeHidden, taskKeywordFilter, taskStatusFilter, taskTo]);

  const applyAnomalyTypeFilter = (type: string) => {
    setTaskAnomalyOnly(true);
    setTaskAnomalyType(type);
    void fetchTasks({
      status: taskStatusFilter,
      account: taskAccountFilter,
      keyword: taskKeywordFilter,
      anomalyOnly: true,
      anomalyType: type,
      from: taskFrom,
      to: taskTo,
      includeHidden: taskIncludeHidden,
    });
  };

  const locateUserFromTask = async (row: AdminTaskRow) => {
    setAdminSection('users');
    setKeyword(row.user.account);
    setUserTaskStatusFilter('all');
    await fetchUsers(row.user.account, 'all');
    setSelectedUserId(row.user.id);
    toast.success(`已定位到用户：${row.user.username}（${row.user.account}）`);
  };

  const getAnomalyTags = (row: AdminTaskRow) => {
    const tags: Array<{ label: string; tone: 'rose' | 'amber' | 'indigo'; filterKey: string }> = [];

    if (row.status === 'failed') {
      tags.push({ label: '任务失败', tone: 'rose', filterKey: 'failed' });
    }
    if (row.status === 'timeout') {
      tags.push({ label: '任务超时', tone: 'rose', filterKey: 'timeout' });
    }
    if (row.deliveryStatus === 'failed' || !!row.deliveryLastError) {
      tags.push({ label: '投递失败', tone: 'amber', filterKey: 'delivery' });
    }
    if (row.error?.startsWith('告警：')) {
      tags.push({ label: '系统告警', tone: 'indigo', filterKey: 'alert' });
    }
    if (!row.error?.startsWith('告警：') && row.error && !['failed', 'timeout'].includes(row.status)) {
      tags.push({ label: '执行异常', tone: 'amber', filterKey: 'execution' });
    }

    return tags;
  };

  const getRedeemStatusLabel = (status: RedeemCodeRow['status']) => {
    if (status === 'active') return '可用中';
    if (status === 'used') return '已用完';
    if (status === 'expired') return '已过期';
    return '已撤销';
  };

  const exportTasksCsv = () => {
    if (taskRows.length === 0) {
      toast.error('当前没有可导出的任务记录');
      return;
    }

    const escapeCell = (value: string | number | null) => {
      const s = String(value ?? '');
      if (s.includes('"') || s.includes(',') || s.includes('\n')) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    };

    const headers = [
      '任务ID',
      '请求ID',
      '账号',
      '用户名',
      '工作流ID',
      '工作流名称',
      '状态',
      '任务平台ID',
      '积分消耗',
      '错误信息',
      '投递状态',
      '投递次数',
      '投递错误',
      '投递确认时间',
      '隐藏时间',
      '结果链接',
      '创建时间',
    ];

    const rows = taskRows.map((row) => [
      row.id,
      row.requestId,
      row.user.account,
      row.user.username,
      row.workflowId,
      row.workflowTitle,
      row.status,
      row.taskId,
      row.pointsCost,
      row.error,
      row.deliveryStatus,
      row.deliveryAttempts,
      row.deliveryLastError,
      row.deliveryAckAt,
      row.hiddenAt,
      row.resultUrl,
      new Date(row.createdAt).toISOString(),
    ]);

    const content = [headers, ...rows]
      .map((line) => line.map((cell) => escapeCell(cell as string | number | null)).join(','))
      .join('\n');

    const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tasks-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast.success('任务 CSV 已导出');
  };

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const meRes = await fetch('/api/me', { cache: 'no-store' });
        const meData = await meRes.json().catch(() => ({}));
        if (!meRes.ok || !meData?.success) {
          throw new Error('未登录');
        }
        if (cancelled) return;
        setAuthUser(meData.data);

        await verifyAdmin();
        if (cancelled) return;
        setVerified(true);

        await Promise.all([
          fetchGlobalStop(),
          fetchSiteNotice(),
          fetchUsers('', 'all'),
          fetchTaskStats(),
          fetchQueueConfig(),
          fetchWorkflowPrechargeSyncStatus(),
          fetchUnknownStatusAudits(),
          fetchDisabledWorkflows(),
          fetchRedeemCodes(),
          fetchTasks({ status: '', account: '', keyword: '', anomalyOnly: true, includeHidden: false }),
        ]);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : '无权限访问';
        toast.error(message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [fetchQueueConfig, fetchTaskStats, fetchTasks, fetchUsers, fetchDisabledWorkflows, fetchRedeemCodes, fetchWorkflowPrechargeSyncStatus, fetchUnknownStatusAudits, fetchSiteNotice]);

  useEffect(() => {
    void fetchSelectedUserSummary(selectedUserId);
  }, [selectedUserId]);

  const toggleGlobalStop = async (enabled: boolean) => {
    try {
      const response = await fetch('/api/admin/system/global-stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.success) {
        toast.error(data?.message || '设置失败');
        return;
      }
      setGlobalStopEnabled(Boolean(data.data?.enabled));
      toast.success(enabled ? '已开启全局紧急停机' : '已关闭全局紧急停机');
    } catch {
      toast.error('设置失败，请稍后重试');
    }
  };

  const adjustSelectedUserPoints = async () => {
    if (!selectedUser) {
      toast.error('请先选择用户');
      return;
    }

    const delta = Number(deltaInput.trim());
    if (!Number.isInteger(delta) || delta === 0) {
      toast.error('请输入非零整数，正数补分，负数扣分');
      return;
    }

    const reason = reasonInput.trim();
    if (!reason) {
      toast.error('请填写调账原因');
      return;
    }

    try {
      const response = await fetch(`/api/admin/users/${selectedUser.id}/points`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delta, reason }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.success) {
        toast.error(data?.message || '调账失败');
        return;
      }

      setUsers((prev) => prev.map((user) => (
        user.id === selectedUser.id
          ? { ...user, points: Number(data.data?.points ?? user.points) }
          : user
      )));
      void fetchSelectedUserSummary(selectedUser.id);
      setDeltaInput('');
      setReasonInput('');
      toast.success('调账成功');
    } catch {
      toast.error('调账失败，请稍后重试');
    }
  };

  const toggleSelectedUserTaskBlock = async () => {
    if (!selectedUser) {
      toast.error('请先选择用户');
      return;
    }

    try {
      const next = !selectedUser.taskBlocked;
      const response = await fetch(`/api/admin/users/${selectedUser.id}/task-block`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blocked: next }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.success) {
        toast.error(data?.message || '更新失败');
        return;
      }

      setUsers((prev) => prev.map((user) => (
        user.id === selectedUser.id ? { ...user, taskBlocked: Boolean(data.data?.taskBlocked) } : user
      )));
      void fetchSelectedUserSummary(selectedUser.id);
      toast.success(next ? '该用户已暂停任务执行' : '该用户已恢复任务执行');
    } catch {
      toast.error('更新失败，请稍后重试');
    }
  };

  const refundPaymentOrder = async (order: UserOrder) => {
    if (!selectedUser) {
      toast.error('请先选择用户');
      return;
    }
    if (order.channel !== 'wechat' || order.status !== 'credited') {
      toast.error('仅支持已到账微信订单人工退款');
      return;
    }
    const ok = window.confirm(`确认对订单 ${order.orderNo} 发起微信退款？退款成功后会回退对应积分。`);
    if (!ok) return;

    try {
      const response = await fetch('/api/admin/pay/refund', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderNo: order.orderNo, reason: '商户后台人工退款' }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.success) {
        toast.error(data?.message || '发起退款失败');
        return;
      }
      toast.success('已发起微信退款，请等待退款回调确认');
      void fetchSelectedUserSummary(selectedUser.id);
    } catch {
      toast.error('发起退款失败，请稍后重试');
    }
  };

  if (loading) {
    return <div className="min-h-screen bg-[#f4f6fb] text-zinc-700 flex items-center justify-center">加载中...</div>;
  }

  if (!authUser || !verified || authUser.role !== 'admin') {
    return (
      <div className="min-h-screen bg-[#f4f6fb] text-zinc-800 flex items-center justify-center p-6">
        <div className="bg-white border border-zinc-200 rounded-2xl p-6 max-w-md w-full text-center">
          <h1 className="text-xl font-semibold mb-2">无权限访问</h1>
          <p className="text-zinc-600 mb-4">此页面仅管理员可访问。</p>
          <Link href="/" className="inline-block px-4 py-2 rounded-xl bg-zinc-900 text-white hover:bg-zinc-800">
            返回首页
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#f4f6fb] text-zinc-800 p-6 md:p-8">
      <Toaster position="top-center" richColors />
      <div className="max-w-6xl mx-auto space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">管理后台</h1>
            <p className="text-sm text-zinc-500 mt-1">管理员：{authUser.account}（{authUser.username}）</p>
          </div>
          <Link href="/" className="px-4 py-2 rounded-xl border border-zinc-300 bg-white hover:bg-zinc-50">
            返回主界面
          </Link>
        </div>

        <div className="bg-white border border-zinc-200 rounded-2xl p-3">
          <div className="inline-flex items-center gap-2 rounded-xl bg-zinc-100 p-1">
            <button
              onClick={() => setAdminSection('system')}
              className={`h-9 px-4 rounded-lg text-sm transition ${
                adminSection === 'system' ? 'bg-white border border-zinc-200 text-zinc-900' : 'text-zinc-600 hover:text-zinc-900'
              }`}
            >
              系统与队列
            </button>
            <button
              onClick={() => setAdminSection('users')}
              className={`h-9 px-4 rounded-lg text-sm transition ${
                adminSection === 'users' ? 'bg-white border border-zinc-200 text-zinc-900' : 'text-zinc-600 hover:text-zinc-900'
              }`}
            >
              用户运营
            </button>
            <button
              onClick={() => setAdminSection('pricing')}
              className={`h-9 px-4 rounded-lg text-sm transition ${
                adminSection === 'pricing' ? 'bg-white border border-zinc-200 text-zinc-900' : 'text-zinc-600 hover:text-zinc-900'
              }`}
            >
              扣费策略
            </button>
            <button
              onClick={() => setAdminSection('workflow-cost')}
              className={`h-9 px-4 rounded-lg text-sm transition ${
                adminSection === 'workflow-cost' ? 'bg-white border border-zinc-200 text-zinc-900' : 'text-zinc-600 hover:text-zinc-900'
              }`}
            >
              应用成本表
            </button>
            <button
              onClick={() => setAdminSection('tasks')}
              className={`h-9 px-4 rounded-lg text-sm transition ${
                adminSection === 'tasks' ? 'bg-white border border-zinc-200 text-zinc-900' : 'text-zinc-600 hover:text-zinc-900'
              }`}
            >
              任务监控
            </button>
            <button
              onClick={() => setAdminSection('redeem')}
              className={`h-9 px-4 rounded-lg text-sm transition ${
                adminSection === 'redeem' ? 'bg-white border border-zinc-200 text-zinc-900' : 'text-zinc-600 hover:text-zinc-900'
              }`}
            >
              兑换码
            </button>
          </div>
        </div>

        {adminSection === 'system' && (
          <div className="grid grid-cols-1 xl:grid-cols-[380px_1fr] gap-5">
            <div className="space-y-5">
              <div className="bg-white border border-zinc-200 rounded-2xl p-5 space-y-4">
                <div>
                  <h2 className="text-lg font-semibold">系统控制</h2>
                  <p className="text-xs text-zinc-500 mt-1">用于紧急停机和恢复，全局影响所有任务提交。</p>
                </div>
                <div className="rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-700">
                  全局紧急停机状态：
                  <span className={`ml-2 font-semibold ${globalStopEnabled ? 'text-rose-600' : 'text-emerald-600'}`}>
                    {globalStopEnabled ? '已开启' : '已关闭'}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => toggleGlobalStop(true)}
                    className="h-10 rounded-xl bg-rose-600 text-white hover:bg-rose-700 text-sm"
                  >
                    开启停机
                  </button>
                  <button
                    onClick={() => toggleGlobalStop(false)}
                    className="h-10 rounded-xl bg-zinc-900 text-white hover:bg-zinc-800 text-sm"
                  >
                    关闭停机
                  </button>
                </div>

                <div className="rounded-xl border border-zinc-200 p-3 space-y-2 bg-zinc-50/50">
                  <div className="text-sm font-medium text-zinc-800">首页通知文案</div>
                  <textarea
                    value={siteNoticeText}
                    onChange={(e) => setSiteNoticeText(e.target.value)}
                    rows={3}
                    className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm outline-none"
                    placeholder="请输入首页顶部通知文案"
                  />
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs text-zinc-500">
                      {siteNoticeUpdatedAt ? `最近更新：${new Date(siteNoticeUpdatedAt).toLocaleString()}` : '尚未配置通知文案'}
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => void fetchSiteNotice()}
                        className={buttonSecondaryClass}
                      >
                        刷新
                      </button>
                      <button
                        onClick={() => void saveSiteNotice()}
                        disabled={siteNoticeSaving}
                        className={buttonPrimaryClass}
                      >
                        {siteNoticeSaving ? '保存中...' : '保存文案'}
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              <div className="bg-white border border-zinc-200 rounded-2xl p-5 space-y-4">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <h2 className="text-lg font-semibold">队列策略配置</h2>
                    <p className="text-xs text-zinc-500 mt-1">仅保留核心并发控制参数，降低误操作风险。</p>
                  </div>
                  <div className="flex items-center gap-2 min-w-[200px] justify-end">
                    <button
                      onClick={() => void fetchQueueConfig()}
                      disabled={queueConfigLoading}
                      className="h-10 min-w-[92px] px-4 rounded-xl border border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {queueConfigLoading ? '刷新中...' : '刷新'}
                    </button>
                    <button
                      onClick={() => void saveQueueConfig()}
                      disabled={queueConfigLoading || !queueConfig}
                      className="h-10 min-w-[92px] px-4 rounded-xl bg-zinc-900 text-white hover:bg-zinc-800 text-sm font-medium shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      保存
                    </button>
                  </div>
                </div>

                {queueRuntime ? (
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-2 py-1.5">生效并发：<span className="font-semibold text-zinc-800">{queueRuntime.effectiveLimit}</span></div>
                    <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-2 py-1.5">动态状态：<span className={`font-semibold ${queueRuntime.enabled ? 'text-emerald-700' : 'text-zinc-700'}`}>{queueRuntime.enabled ? '已启用' : '已禁用'}</span></div>
                    <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-2 py-1.5">最近信号：{queueRuntime.lastSignal}</div>
                    <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-2 py-1.5">最近调档：{queueRuntime.lastScaledAt ? new Date(queueRuntime.lastScaledAt).toLocaleString() : 'N/A'}</div>
                  </div>
                ) : null}

                {!queueConfig || queueConfigLoading ? (
                  <div className="text-sm text-zinc-500">加载中...</div>
                ) : (
                  <div className="rounded-xl border border-zinc-200 p-3 space-y-2">
                    <div className="text-sm font-medium text-zinc-700">动态并发控制</div>
                    <div className="grid grid-cols-1 gap-2">
                      <label className="h-10 rounded-xl border border-zinc-200 px-3 text-sm inline-flex items-center gap-2 bg-white">
                        <input
                          type="checkbox"
                          checked={queueConfig.concurrency.enabled}
                          onChange={(e) => setQueueConfig((prev) => prev ? {
                            ...prev,
                            concurrency: {
                              ...prev.concurrency,
                              enabled: e.target.checked,
                            },
                          } : prev)}
                        />
                        启用自动调档
                      </label>
                      <div className="space-y-1">
                        <div className="text-xs text-zinc-500">基础并发上限（任务数）</div>
                        <div className="h-10 w-full rounded-xl border border-zinc-200 px-3 text-sm flex items-center gap-2">
                          <input
                            type="number"
                            min={1}
                            value={queueConfig.concurrency.baseLimit}
                            onChange={(e) => setQueueConfig((prev) => prev ? {
                              ...prev,
                              concurrency: {
                                ...prev.concurrency,
                                baseLimit: Math.max(1, Number(e.target.value || 1)),
                              },
                            } : prev)}
                            className="w-full bg-transparent outline-none"
                            placeholder="例如：80"
                          />
                          <span className="text-zinc-500">个</span>
                        </div>
                      </div>

                    </div>
                    <p className="text-xs text-zinc-500">固定策略：最小并发 40、最大并发 90、降档步长 5、回升步长 2、回升冷却 120 秒。</p>
                  </div>
                )}
              </div>

              <div className="bg-white border border-zinc-200 rounded-2xl p-5 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <h2 className="text-lg font-semibold">未知状态码告警</h2>
                    <p className="text-xs text-zinc-500 mt-1">最近 RunningHub 未识别状态码（action=runninghub_unknown_status）。</p>
                  </div>
                  <button
                    onClick={() => void fetchUnknownStatusAudits()}
                    disabled={unknownStatusAuditsLoading}
                    className={buttonSecondaryClass}
                  >
                    {unknownStatusAuditsLoading ? '刷新中...' : '刷新'}
                  </button>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => setUnknownStatusCodeFilter('all')}
                    className={`h-7 px-2.5 rounded-lg border text-xs ${
                      unknownStatusCodeFilter === 'all'
                        ? 'bg-zinc-900 text-white border-zinc-900'
                        : 'bg-white text-zinc-700 border-zinc-300 hover:bg-zinc-50'
                    }`}
                  >
                    全部
                  </button>
                  {unknownStatusCodeOptions.map((code) => (
                    <button
                      key={`unknown-code-${code}`}
                      onClick={() => setUnknownStatusCodeFilter(code)}
                      className={`h-7 px-2.5 rounded-lg border text-xs ${
                        unknownStatusCodeFilter === code
                          ? 'bg-zinc-900 text-white border-zinc-900'
                          : 'bg-white text-zinc-700 border-zinc-300 hover:bg-zinc-50'
                      }`}
                    >
                      code={code}
                    </button>
                  ))}
                </div>

                <div className="max-h-56 overflow-auto rounded-xl border border-zinc-200">
                  {filteredUnknownStatusAudits.length === 0 ? (
                    <div className="p-3 text-xs text-zinc-500">暂无未知状态码告警</div>
                  ) : (
                    filteredUnknownStatusAudits.map((item) => (
                      <div key={item.id} className="p-2 text-xs border-b border-zinc-100">
                        <div className="text-zinc-800">
                          {item.path} · code={item.status}
                          {item.requestId ? ` · taskId=${item.requestId}` : ''}
                        </div>
                        <div className="text-zinc-500 mt-1">{new Date(item.createdAt).toLocaleString()}</div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>

            <div className="bg-white border border-zinc-200 rounded-2xl p-5 space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">AI应用管理</h2>
                  <p className="text-xs text-zinc-500 mt-1">禁用后该应用对所有用户不可用；自动禁用由系统检测下架触发。</p>
                </div>
                <button
                  onClick={() => void fetchDisabledWorkflows()}
                  className={buttonSecondaryClass}
                >
                  刷新
                </button>
              </div>

              <div className="rounded-xl border border-zinc-200 p-3 space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    className="h-10 rounded-xl border border-zinc-200 px-3 text-sm bg-white min-w-[220px] max-w-xs"
                    value=""
                    onChange={(e) => {
                      const id = e.target.value;
                      if (!id) return;
                      setSelectedWorkflowIds((prev) => {
                        const next = new Set(prev);
                        if (next.has(id)) next.delete(id);
                        else next.add(id);
                        return next;
                      });
                      e.target.value = '';
                    }}
                  >
                    <option value="">选择应用添加到操作列表...</option>
                    {workflows.map((wf) => {
                      const isDisabled = disabledWorkflows.some((d) => d.workflowId === wf.workflowId);
                      return (
                        <option key={wf.workflowId} value={wf.workflowId}>
                          {selectedWorkflowIds.has(wf.workflowId) ? '✓ ' : ''}{wf.title}（{isDisabled ? '已禁用' : '正常'}）
                        </option>
                      );
                    })}
                  </select>
                  <button
                    onClick={() => setSelectedWorkflowIds(new Set(workflows.map((w) => w.workflowId)))}
                    className={buttonSecondaryClass}
                  >
                    全选
                  </button>
                  <button
                    onClick={() => setSelectedWorkflowIds(new Set())}
                    className={buttonSecondaryClass}
                  >
                    清空
                  </button>
                  <button
                    disabled={selectedWorkflowIds.size === 0 || Object.values(workflowToggling).some(Boolean)}
                    onClick={() => void toggleSelectedWorkflows('disable')}
                    className={buttonDangerClass}
                  >
                    禁用所选（{selectedWorkflowIds.size}）
                  </button>
                  <button
                    disabled={selectedWorkflowIds.size === 0 || Object.values(workflowToggling).some(Boolean)}
                    onClick={() => void toggleSelectedWorkflows('enable')}
                    className={buttonPrimaryClass}
                  >
                    启用所选（{selectedWorkflowIds.size}）
                  </button>
                </div>

                {selectedWorkflowIds.size > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {Array.from(selectedWorkflowIds).map((id) => {
                      const wf = workflows.find((w) => w.workflowId === id);
                      return (
                        <span key={id} className="flex items-center gap-1 px-2 py-1 rounded-lg bg-zinc-100 text-sm">
                          {wf?.title ?? id}
                          <button
                            onClick={() => setSelectedWorkflowIds((prev) => { const next = new Set(prev); next.delete(id); return next; })}
                            className="text-zinc-400 hover:text-zinc-700 ml-1"
                          >✕</button>
                        </span>
                      );
                    })}
                  </div>
                )}

                {disabledWorkflows.length > 0 ? (
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-zinc-600">当前已禁用（{disabledWorkflows.length}）</p>
                    <div className="divide-y divide-zinc-100 border border-zinc-100 rounded-xl overflow-hidden">
                      {disabledWorkflows.map((d) => {
                        const wf = workflows.find((w) => w.workflowId === d.workflowId);
                        return (
                          <div key={d.workflowId} className="flex items-center justify-between gap-3 px-4 py-2.5 bg-rose-50/50">
                            <div className="min-w-0">
                              <p className="text-sm font-medium truncate">{wf?.title ?? d.workflowId}</p>
                              {d.reason && <p className="text-xs text-rose-500 truncate">原因：{d.reason}</p>}
                            </div>
                            <button
                              disabled={Boolean(workflowToggling[d.workflowId])}
                              onClick={() => void toggleWorkflow(d.workflowId, 'enable')}
                              className="h-8 px-3 rounded-xl text-xs bg-zinc-900 text-white hover:bg-zinc-800 disabled:opacity-40 shrink-0"
                            >
                              {workflowToggling[d.workflowId] ? '处理中...' : '启用'}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-zinc-400">当前所有AI应用均正常运行</p>
                )}
              </div>
            </div>
          </div>
        )}

        {adminSection === 'pricing' && (
          <div className="bg-white border border-zinc-200 rounded-2xl p-5 space-y-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">扣费策略配置</h2>
                <p className="text-xs text-zinc-500 mt-1">用于控制成功/失败/运行中取消任务的成本换算与利润倍率。</p>
              </div>
              <div className="flex items-center gap-2 min-w-[200px] justify-end">
                <button
                  onClick={() => void fetchQueueConfig()}
                  disabled={queueConfigLoading}
                  className="h-10 min-w-[92px] px-4 rounded-xl border border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {queueConfigLoading ? '刷新中...' : '刷新'}
                </button>
                <button
                  onClick={() => void saveQueueConfig()}
                  disabled={queueConfigLoading || !queueConfig}
                  className="h-10 min-w-[92px] px-4 rounded-xl bg-zinc-900 text-white hover:bg-zinc-800 text-sm font-medium shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  保存
                </button>
                <button
                  onClick={() => void syncWorkflowPrechargePoints()}
                  disabled={workflowPrechargeSyncing || !queueConfig}
                  className="h-10 min-w-[112px] px-4 rounded-xl border border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {workflowPrechargeSyncing ? '同步中...' : '同步预占积分'}
                </button>
              </div>
            </div>

            <div className="text-xs text-zinc-500">
              当前生效预占版本：{workflowPrechargeSyncedAt ? new Date(workflowPrechargeSyncedAt).toLocaleString() : '未同步（沿用旧版本）'}
            </div>

            {!queueConfig || queueConfigLoading ? (
              <div className="text-sm text-zinc-500">加载中...</div>
            ) : (
              <div className="rounded-xl border border-zinc-200 p-4 space-y-3 bg-zinc-50/50">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <div className="text-xs text-zinc-500">运行成本单价（元/小时）</div>
                    <div className="h-10 w-full rounded-xl border border-zinc-200 px-3 text-sm flex items-center gap-2 bg-white">
                      <input
                        type="number"
                        min={0.0001}
                        step={0.0001}
                        value={queueConfig.pricing.runningCostYuanPerHour}
                        onChange={(e) => setQueueConfig((prev) => prev ? {
                          ...prev,
                          pricing: {
                            ...prev.pricing,
                            runningCostYuanPerHour: Math.max(0.0001, Number(e.target.value || 0.0001)),
                          },
                        } : prev)}
                        className="w-full bg-transparent outline-none"
                        placeholder="例如：6"
                      />
                      <span className="text-zinc-500">元/小时</span>
                    </div>
                  </div>

                  <div className="space-y-1">
                    <div className="text-xs text-zinc-500">成功扣费倍率（成本×倍率）</div>
                    <div className="h-10 w-full rounded-xl border border-zinc-200 px-3 text-sm flex items-center gap-2 bg-white">
                      <input
                        type="number"
                        min={0}
                        step={0.01}
                        value={queueConfig.pricing.successChargeMultiplier}
                        onChange={(e) => setQueueConfig((prev) => prev ? {
                          ...prev,
                          pricing: {
                            ...prev.pricing,
                            successChargeMultiplier: Math.max(0, Number(e.target.value || 0)),
                          },
                        } : prev)}
                        className="w-full bg-transparent outline-none"
                        placeholder="例如：4.7"
                      />
                      <span className="text-zinc-500">倍</span>
                    </div>
                    <div className={`text-xs ${grossMarginToneClass(queueConfig.pricing.successChargeMultiplier)}`}>
                      预估毛利润：{formatGrossMargin(queueConfig.pricing.successChargeMultiplier)}
                    </div>
                  </div>

                  <div className="space-y-1">
                    <div className="text-xs text-zinc-500">失败扣费倍率（成本×倍率）</div>
                    <div className="h-10 w-full rounded-xl border border-zinc-200 px-3 text-sm flex items-center gap-2 bg-white">
                      <input
                        type="number"
                        min={0}
                        step={0.01}
                        value={queueConfig.pricing.failedChargeMultiplier}
                        onChange={(e) => setQueueConfig((prev) => prev ? {
                          ...prev,
                          pricing: {
                            ...prev.pricing,
                            failedChargeMultiplier: Math.max(0, Number(e.target.value || 0)),
                          },
                        } : prev)}
                        className="w-full bg-transparent outline-none"
                        placeholder="例如：4.4"
                      />
                      <span className="text-zinc-500">倍</span>
                    </div>
                    <div className={`text-xs ${grossMarginToneClass(queueConfig.pricing.failedChargeMultiplier)}`}>
                      预估毛利润：{formatGrossMargin(queueConfig.pricing.failedChargeMultiplier)}
                    </div>
                  </div>

                  <div className="space-y-1">
                    <div className="text-xs text-zinc-500">取消扣费倍率（成本×倍率）</div>
                    <div className="h-10 w-full rounded-xl border border-zinc-200 px-3 text-sm flex items-center gap-2 bg-white">
                      <input
                        type="number"
                        min={0}
                        step={0.01}
                        value={queueConfig.pricing.cancelRunningChargeMultiplier}
                        onChange={(e) => setQueueConfig((prev) => prev ? {
                          ...prev,
                          pricing: {
                            ...prev.pricing,
                            cancelRunningChargeMultiplier: Math.max(0, Number(e.target.value || 0)),
                          },
                        } : prev)}
                        className="w-full bg-transparent outline-none"
                        placeholder="例如：3.6"
                      />
                      <span className="text-zinc-500">倍</span>
                    </div>
                    <div className={`text-xs ${grossMarginToneClass(queueConfig.pricing.cancelRunningChargeMultiplier)}`}>
                      预估毛利润：{formatGrossMargin(queueConfig.pricing.cancelRunningChargeMultiplier)}
                    </div>
                  </div>

                  <div className="space-y-1">
                    <div className="text-xs text-zinc-500">成本安全系数（&gt;=1）</div>
                    <div className="h-10 w-full rounded-xl border border-zinc-200 px-3 text-sm flex items-center gap-2 bg-white">
                      <input
                        type="number"
                        min={1}
                        step={0.01}
                        value={queueConfig.pricing.cancelRunningSafetyFactor}
                        onChange={(e) => setQueueConfig((prev) => prev ? {
                          ...prev,
                          pricing: {
                            ...prev.pricing,
                            cancelRunningSafetyFactor: Math.max(1, Number(e.target.value || 1)),
                          },
                        } : prev)}
                        className="w-full bg-transparent outline-none"
                        placeholder="例如：1.03"
                      />
                      <span className="text-zinc-500">系数</span>
                    </div>
                  </div>

                  <div className="space-y-1">
                    <div className="text-xs text-zinc-500">取消最低扣分</div>
                    <div className="h-10 w-full rounded-xl border border-zinc-200 px-3 text-sm flex items-center gap-2 bg-white">
                      <input
                        type="number"
                        min={0}
                        step={1}
                        value={queueConfig.pricing.cancelRunningMinChargePoints}
                        onChange={(e) => setQueueConfig((prev) => prev ? {
                          ...prev,
                          pricing: {
                            ...prev.pricing,
                            cancelRunningMinChargePoints: Math.max(0, Math.floor(Number(e.target.value || 0))),
                          },
                        } : prev)}
                        className="w-full bg-transparent outline-none"
                        placeholder="例如：10"
                      />
                      <span className="text-zinc-500">积分</span>
                    </div>
                  </div>
                </div>

                <div className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs text-zinc-600 space-y-1">
                  <div className="text-zinc-500">参考目标：毛利润建议维持在 75%~80%。</div>
                  <div>计算规则：成本积分 = ceil(成本金额(元) × 100 × 成本安全系数)</div>
                  <div>成功实扣 = max(取消最低扣分, ceil(成本积分 × 成功扣费倍率))</div>
                  <div>失败实扣 = max(取消最低扣分, ceil(成本积分 × 失败扣费倍率))</div>
                  <div>取消实扣 = max(取消最低扣分, ceil(成本积分 × 取消扣费倍率))</div>
                  <div>退款积分 = 预扣积分 - 实扣积分（最低为0）</div>
                  <div>成本来源：优先 RunningHub 消费记录，读取失败时按运行时长估算。</div>
                </div>

                <div className="rounded-lg border border-zinc-200 bg-white px-3 py-3 space-y-2">
                  <div className="text-xs font-medium text-zinc-700">扣费小计算器</div>
                  <div className="flex flex-col md:flex-row md:items-center gap-2">
                    <div className="h-10 w-full md:w-72 rounded-xl border border-zinc-200 px-3 text-sm flex items-center gap-2 bg-white">
                      <input
                        type="number"
                        min={0}
                        step={0.0001}
                        value={pricingCalculatorCostYuan}
                        onChange={(e) => setPricingCalculatorCostYuan(e.target.value)}
                        className="w-full bg-transparent outline-none"
                        placeholder="输入成本金额"
                      />
                      <span className="text-zinc-500">元</span>
                    </div>
                    <div className="text-xs text-zinc-500">输入一笔成本，实时预估三档实扣积分</div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-xs">
                    <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-zinc-700">
                      成功实扣：
                      <span className="font-semibold text-zinc-900">
                        {estimateChargePoints(Number(pricingCalculatorCostYuan || 0), queueConfig.pricing.successChargeMultiplier)}
                      </span>
                      积分
                    </div>
                    <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-zinc-700">
                      失败实扣：
                      <span className="font-semibold text-zinc-900">
                        {estimateChargePoints(Number(pricingCalculatorCostYuan || 0), queueConfig.pricing.failedChargeMultiplier)}
                      </span>
                      积分
                    </div>
                    <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-zinc-700">
                      取消实扣：
                      <span className="font-semibold text-zinc-900">
                        {estimateChargePoints(Number(pricingCalculatorCostYuan || 0), queueConfig.pricing.cancelRunningChargeMultiplier)}
                      </span>
                      积分
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {adminSection === 'workflow-cost' && (
          <div className="bg-white border border-zinc-200 rounded-2xl p-5 space-y-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">按 workflowId 成本拆解</h2>
                <p className="text-xs text-zinc-500 mt-1">按 RH 币 / 人民币 / 服务器运行成本拆分，并自动计算预占积分。</p>
              </div>
              <div className="flex items-center gap-2 min-w-[200px] justify-end">
                <button
                  onClick={() => void fetchQueueConfig()}
                  disabled={queueConfigLoading}
                  className="h-10 min-w-[92px] px-4 rounded-xl border border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {queueConfigLoading ? '刷新中...' : '刷新'}
                </button>
                <button
                  onClick={() => void saveQueueConfig()}
                  disabled={queueConfigLoading || !queueConfig}
                  className="h-10 min-w-[92px] px-4 rounded-xl bg-zinc-900 text-white hover:bg-zinc-800 text-sm font-medium shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  保存
                </button>
              </div>
            </div>

            {!queueConfig || queueConfigLoading ? (
              <div className="text-sm text-zinc-500">加载中...</div>
            ) : (
              <>
                <div className="rounded-xl border border-zinc-200 p-4 bg-zinc-50/60 space-y-3">
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
                    <div className="space-y-1">
                      <div className="text-xs text-zinc-500">RH 币折算（元 / RH币）</div>
                      <div className="h-10 rounded-xl border border-zinc-200 bg-white px-3 text-sm flex items-center gap-2">
                        <input
                          type="number"
                          min={0.000001}
                          step={0.000001}
                          value={queueConfig.pricing.rhCoinToYuan}
                          onChange={(e) => setQueueConfig((prev) => prev ? {
                            ...prev,
                            pricing: {
                              ...prev.pricing,
                              rhCoinToYuan: Math.max(0.000001, Number(e.target.value || 0.000001)),
                            },
                          } : prev)}
                          className="w-full bg-transparent outline-none"
                        />
                        <span className="text-zinc-500">元</span>
                      </div>
                    </div>
                    <div className="space-y-1">
                      <div className="text-xs text-zinc-500">Lite（元/小时）</div>
                      <div className="h-10 rounded-xl border border-zinc-200 bg-white px-3 text-sm flex items-center gap-2">
                        <input
                          type="number"
                          min={0.0001}
                          step={0.0001}
                          value={queueConfig.pricing.instanceHourlyCost.lite}
                          onChange={(e) => setQueueConfig((prev) => prev ? {
                            ...prev,
                            pricing: {
                              ...prev.pricing,
                              instanceHourlyCost: {
                                ...prev.pricing.instanceHourlyCost,
                                lite: Math.max(0.0001, Number(e.target.value || 0.0001)),
                              },
                            },
                          } : prev)}
                          className="w-full bg-transparent outline-none"
                        />
                        <span className="text-zinc-500">元</span>
                      </div>
                    </div>
                    <div className="space-y-1">
                      <div className="text-xs text-zinc-500">Standard 24GB（元/小时）</div>
                      <div className="h-10 rounded-xl border border-zinc-200 bg-white px-3 text-sm flex items-center gap-2">
                        <input
                          type="number"
                          min={0.0001}
                          step={0.0001}
                          value={queueConfig.pricing.instanceHourlyCost.default}
                          onChange={(e) => setQueueConfig((prev) => prev ? {
                            ...prev,
                            pricing: {
                              ...prev.pricing,
                              instanceHourlyCost: {
                                ...prev.pricing.instanceHourlyCost,
                                default: Math.max(0.0001, Number(e.target.value || 0.0001)),
                              },
                            },
                          } : prev)}
                          className="w-full bg-transparent outline-none"
                        />
                        <span className="text-zinc-500">元</span>
                      </div>
                    </div>
                    <div className="space-y-1">
                      <div className="text-xs text-zinc-500">Plus 48GB（元/小时）</div>
                      <div className="h-10 rounded-xl border border-zinc-200 bg-white px-3 text-sm flex items-center gap-2">
                        <input
                          type="number"
                          min={0.0001}
                          step={0.0001}
                          value={queueConfig.pricing.instanceHourlyCost.plus}
                          onChange={(e) => setQueueConfig((prev) => prev ? {
                            ...prev,
                            pricing: {
                              ...prev.pricing,
                              instanceHourlyCost: {
                                ...prev.pricing.instanceHourlyCost,
                                plus: Math.max(0.0001, Number(e.target.value || 0.0001)),
                              },
                            },
                          } : prev)}
                          className="w-full bg-transparent outline-none"
                        />
                        <span className="text-zinc-500">元</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="h-10 w-56 rounded-xl border border-zinc-200 bg-white px-3 text-sm flex items-center gap-2">
                      <span className="text-zinc-500">默认毛利率</span>
                      <input
                        type="number"
                        min={0}
                        max={99}
                        step={0.1}
                        value={queueConfig.pricing.defaultGrossMarginPercent}
                        onChange={(e) => setQueueConfig((prev) => prev ? {
                          ...prev,
                          pricing: {
                            ...prev.pricing,
                            defaultGrossMarginPercent: Math.min(99, Math.max(0, Number(e.target.value || 0))),
                          },
                        } : prev)}
                        className="w-full bg-transparent outline-none text-right"
                      />
                      <span className="text-zinc-500">%</span>
                    </div>
                    <button
                      onClick={() => setQueueConfig((prev) => {
                        if (!prev) return prev;
                        const nextMargin = Math.min(99, Math.max(0, Number(prev.pricing.defaultGrossMarginPercent || 0)));
                        const nextProfiles = Object.fromEntries(
                          Object.entries(prev.pricing.workflowProfiles || {}).map(([workflowId, profile]) => [
                            workflowId,
                            {
                              ...profile,
                              grossMarginPercent: nextMargin,
                            },
                          ])
                        );
                        return {
                          ...prev,
                          pricing: {
                            ...prev.pricing,
                            workflowProfiles: nextProfiles,
                          },
                        };
                      })}
                      className="h-10 px-4 rounded-xl border border-zinc-300 bg-white hover:bg-zinc-50 text-sm"
                    >
                      应用到全部 workflow
                    </button>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-xs text-zinc-600">
                    <div>计费规则：所有机型均按秒计费；并发任务按累计运行时长计费。</div>
                    <div>毛利率输入单位为 %，会自动换算成倍率。</div>
                    <div>预占积分 = 成本积分 × 毛利倍率（含安全系数与最低扣分）。</div>
                  </div>
                </div>

                <div className="max-h-[620px] overflow-auto rounded-xl border border-zinc-200 bg-white">
                  <table className="min-w-[1600px] w-full table-fixed text-xs">
                    <thead className="sticky top-0 bg-zinc-50 z-10">
                      <tr className="text-zinc-600 border-b border-zinc-200">
                        <th className="text-left px-3 py-2 w-[170px]">workflowId</th>
                        <th className="text-left px-3 py-2 w-[180px]">应用</th>
                        <th className="text-left px-3 py-2 w-[120px]">机型</th>
                        <th className="text-left px-3 py-2 w-[110px]">运行时长(s)</th>
                        <th className="text-left px-3 py-2 w-[110px]">RH币</th>
                        <th className="text-left px-3 py-2 w-[120px]">人民币(元)</th>
                        <th className="text-left px-3 py-2 w-[130px]">服务器成本(元)</th>
                        <th className="text-left px-3 py-2 w-[120px]">RH成本(元)</th>
                        <th className="text-left px-3 py-2 w-[120px]">总成本(元)</th>
                        <th className="text-left px-3 py-2 w-[120px]">毛利率(%)</th>
                        <th className="text-left px-3 py-2 w-[120px]">预占积分</th>
                      </tr>
                    </thead>
                    <tbody>
                      {workflowCostRows.map((row) => (
                        <tr key={row.workflow.workflowId} className="border-b border-zinc-100 align-top">
                          <td className="px-3 py-2 font-mono text-zinc-700">{row.workflow.workflowId}</td>
                          <td className="px-3 py-2 text-zinc-800">{row.workflow.title}</td>
                          <td className="px-3 py-2">
                            <select
                              value={row.profile.instanceType}
                              onChange={(e) => updateWorkflowProfile(row.workflow.workflowId, (prev) => ({
                                ...prev,
                                instanceType: e.target.value === 'default' || e.target.value === 'plus' ? e.target.value : 'lite',
                              }))}
                              className="h-8 w-full rounded-lg border border-zinc-200 px-2 bg-white"
                            >
                              <option value="lite">Lite</option>
                              <option value="default">Standard</option>
                              <option value="plus">Plus</option>
                            </select>
                          </td>
                          <td className="px-3 py-2">
                            <input
                              type="number"
                              min={0}
                              step={1}
                              value={row.profile.runtimeSeconds}
                              onChange={(e) => updateWorkflowProfile(row.workflow.workflowId, (prev) => ({
                                ...prev,
                                runtimeSeconds: Math.max(0, Number(e.target.value || 0)),
                              }))}
                              className="h-8 w-full rounded-lg border border-zinc-200 px-2"
                            />
                          </td>
                          <td className="px-3 py-2">
                            <input
                              type="number"
                              min={0}
                              step={1}
                              value={row.profile.extraCostRhCoins}
                              onChange={(e) => updateWorkflowProfile(row.workflow.workflowId, (prev) => ({
                                ...prev,
                                extraCostRhCoins: Math.max(0, Number(e.target.value || 0)),
                              }))}
                              className="h-8 w-full rounded-lg border border-zinc-200 px-2"
                            />
                          </td>
                          <td className="px-3 py-2">
                            <input
                              type="number"
                              min={0}
                              step={0.01}
                              value={row.profile.extraCostYuan}
                              onChange={(e) => updateWorkflowProfile(row.workflow.workflowId, (prev) => ({
                                ...prev,
                                extraCostYuan: Math.max(0, Number(e.target.value || 0)),
                              }))}
                              className="h-8 w-full rounded-lg border border-zinc-200 px-2"
                            />
                          </td>
                          <td className="px-3 py-2 text-zinc-700">{row.serverCostYuan.toFixed(4)}</td>
                          <td className="px-3 py-2 text-zinc-700">{row.rhCostYuan.toFixed(4)}</td>
                          <td className="px-3 py-2 text-zinc-900 font-medium">{row.totalCostYuan.toFixed(4)}</td>
                          <td className="px-3 py-2">
                            <div className="h-8 w-full rounded-lg border border-zinc-200 px-2 flex items-center gap-1">
                              <input
                                type="number"
                                min={0}
                                max={99}
                                step={0.1}
                                value={row.profile.grossMarginPercent}
                                onChange={(e) => updateWorkflowProfile(row.workflow.workflowId, (prev) => ({
                                  ...prev,
                                  grossMarginPercent: Math.min(99, Math.max(0, Number(e.target.value || 0))),
                                }))}
                                className="w-full bg-transparent outline-none"
                              />
                              <span className="text-zinc-500">%</span>
                            </div>
                          </td>
                          <td className="px-3 py-2 font-semibold text-zinc-900">{row.prechargePoints}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        )}

        {adminSection === 'redeem' && (
        <div className="grid grid-cols-1 xl:grid-cols-[420px_1fr] gap-5">
          <div className="bg-white border border-zinc-200 rounded-2xl p-5 space-y-4">
            <div>
              <h2 className="text-lg font-semibold">创建兑换码</h2>
              <p className="text-xs text-zinc-500 mt-1">支持通用码与专属码，生成后自动记录，可随时查看状态。</p>
            </div>

            <div className="rounded-xl border border-zinc-200 p-3 space-y-3">
              <div className="space-y-1">
                <div className="text-xs text-zinc-500">兑换码类型</div>
                <select
                  value={redeemCreateMode}
                  onChange={(e) => setRedeemCreateMode(e.target.value === 'bound' ? 'bound' : 'universal')}
                  className="h-10 w-full rounded-xl border border-zinc-200 px-3 text-sm"
                >
                  <option value="universal">通用码（任意用户）</option>
                  <option value="bound">专属码（绑定用户）</option>
                </select>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div className="space-y-1">
                  <div className="text-xs text-zinc-500">发放积分</div>
                  <div className="h-10 w-full rounded-xl border border-zinc-200 px-3 text-sm flex items-center gap-2">
                    <input
                      value={redeemPointsInput}
                      onChange={(e) => setRedeemPointsInput(e.target.value.replace(/[^\d]/g, ''))}
                      placeholder="1000"
                      className="w-full bg-transparent outline-none"
                    />
                    <span className="text-zinc-500">积分</span>
                  </div>
                </div>

                <div className="space-y-1">
                  <div className="text-xs text-zinc-500">可使用次数</div>
                  <div className="h-10 w-full rounded-xl border border-zinc-200 px-3 text-sm flex items-center gap-2">
                    <input
                      value={redeemMaxUsesInput}
                      onChange={(e) => setRedeemMaxUsesInput(e.target.value.replace(/[^\d]/g, ''))}
                      disabled={redeemCreateMode === 'bound'}
                      placeholder={redeemCreateMode === 'bound' ? '固定1' : '例如：5'}
                      className="w-full bg-transparent outline-none disabled:text-zinc-400"
                    />
                    <span className="text-zinc-500">次</span>
                  </div>
                </div>
              </div>

              {redeemCreateMode === 'bound' ? (
                <div className="rounded-xl border border-zinc-200 p-3 space-y-2 bg-zinc-50/60">
                  <div className="text-xs text-zinc-500">绑定用户（搜索后点击选择）</div>
                  <input
                    value={selectedRedeemBoundUser ? `${selectedRedeemBoundUser.account} / ${selectedRedeemBoundUser.username}` : ''}
                    readOnly
                    placeholder="绑定用户会在这里显示"
                    className="h-10 w-full rounded-xl border border-zinc-200 px-3 text-sm bg-white"
                  />
                  <div className="flex items-center gap-2">
                    <input
                      value={redeemBindKeyword}
                      onChange={(e) => setRedeemBindKeyword(e.target.value)}
                      placeholder="账号或用户名关键词"
                      className="h-10 w-44 rounded-xl border border-zinc-200 px-3 text-sm bg-white"
                    />
                    <button
                      onClick={() => void searchRedeemBindUsers(redeemBindKeyword)}
                      className="h-10 px-3 rounded-xl border border-zinc-300 bg-white hover:bg-zinc-50 text-sm"
                    >
                      搜索
                    </button>
                    <button
                      onClick={() => setRedeemBoundUserId('')}
                      className="h-10 px-3 rounded-xl border border-zinc-300 bg-white hover:bg-zinc-50 text-sm"
                    >
                      清空绑定
                    </button>
                  </div>

                  {!selectedRedeemBoundUser ? <div className="text-xs text-zinc-500">尚未选择绑定用户</div> : null}

                  <div className="max-h-36 overflow-auto rounded-lg border border-zinc-200 bg-white">
                    {redeemBindLoading ? (
                      <div className="p-2 text-xs text-zinc-500">搜索中...</div>
                    ) : redeemBindKeyword.trim() && redeemBindUserResults.length === 0 ? (
                      <div className="p-2 text-xs text-zinc-500">没有匹配用户</div>
                    ) : (
                      redeemBindUserResults.map((item) => (
                        <button
                          key={item.id}
                          onClick={() => setRedeemBoundUserId(item.id)}
                          className={`w-full text-left px-2 py-1.5 text-xs border-b last:border-b-0 border-zinc-100 hover:bg-zinc-50 ${redeemBoundUserId === item.id ? 'bg-[#eef3ff]' : ''}`}
                        >
                          {item.account} / {item.username}
                        </button>
                      ))
                    )}
                  </div>
                </div>
              ) : null}

              <div className="space-y-1">
                <div className="text-xs text-zinc-500">有效期（按生成时刻自动计算）</div>
                <div className="space-y-2 rounded-xl border border-zinc-200 p-3 bg-zinc-50/50">
                  <div className="flex items-center gap-3 text-xs">
                    <label className="inline-flex items-center gap-1.5 text-zinc-600">
                      <input
                        type="radio"
                        checked={redeemValidityMode === 'preset'}
                        onChange={() => setRedeemValidityMode('preset')}
                      />
                      固定选项
                    </label>
                    <label className="inline-flex items-center gap-1.5 text-zinc-600">
                      <input
                        type="radio"
                        checked={redeemValidityMode === 'custom'}
                        onChange={() => setRedeemValidityMode('custom')}
                      />
                      自定义天数
                    </label>
                  </div>

                  {redeemValidityMode === 'preset' ? (
                    <select
                      value={redeemValidityPreset}
                      onChange={(e) => setRedeemValidityPreset(e.target.value as '1' | '3' | '7' | '30' | '0')}
                      className="h-10 w-full rounded-xl border border-zinc-200 px-3 text-sm bg-white"
                    >
                      <option value="1">1天</option>
                      <option value="3">3天</option>
                      <option value="7">7天</option>
                      <option value="30">30天</option>
                      <option value="0">永久</option>
                    </select>
                  ) : (
                    <div className="h-10 w-full rounded-xl border border-zinc-200 px-3 text-sm flex items-center gap-2 bg-white">
                      <input
                        value={redeemValidDaysInput}
                        onChange={(e) => setRedeemValidDaysInput(e.target.value.replace(/[^\d]/g, ''))}
                        className="w-full bg-transparent outline-none"
                        placeholder="例如：5"
                      />
                      <span className="text-zinc-500">天</span>
                    </div>
                  )}
                </div>
              </div>

              <div className="space-y-1">
                <div className="text-xs text-zinc-500">备注（可选）</div>
                <input
                  value={redeemNote}
                  onChange={(e) => setRedeemNote(e.target.value)}
                  className="h-10 w-full rounded-xl border border-zinc-200 px-3 text-sm"
                  placeholder="例如：线下确认付款"
                />
              </div>

              <div className="rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-600">
                默认换算提示：<span className="font-medium text-zinc-700">1元 = 100积分</span>（仅提示，不强制计算）
              </div>

              <button
                onClick={() => void createRedeemCode()}
                className="w-full h-10 rounded-xl bg-zinc-900 text-white hover:bg-zinc-800 text-sm"
              >
                生成兑换码
              </button>
            </div>

            {latestPlainRedeemCode ? (
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3">
                <div className="text-xs text-emerald-700 mb-1">新兑换码（仅本次显示）</div>
                <div className="text-base font-semibold tracking-wider text-emerald-800">{latestPlainRedeemCode}</div>
              </div>
            ) : null}
          </div>

          <div className="bg-white border border-zinc-200 rounded-2xl p-5 space-y-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">兑换码列表</h2>
                <p className="text-xs text-zinc-500 mt-1">筛选状态与类型，查看创建/使用/过期信息。</p>
              </div>
              <div className="flex items-center gap-2">
                <select
                  value={redeemStatusFilter}
                  onChange={(e) => {
                    const next = e.target.value as 'all' | 'active' | 'used' | 'expired' | 'revoked';
                    setRedeemStatusFilter(next);
                    void fetchRedeemCodes({ status: next, mode: redeemModeFilter });
                  }}
                  className="h-9 rounded-xl border border-zinc-300 px-3 text-sm bg-white"
                >
                  <option value="all">全部状态</option>
                  <option value="active">可用中</option>
                  <option value="used">已用完</option>
                  <option value="expired">已过期</option>
                  <option value="revoked">已撤销</option>
                </select>
                <select
                  value={redeemModeFilter}
                  onChange={(e) => {
                    const next = e.target.value as 'all' | 'universal' | 'bound';
                    setRedeemModeFilter(next);
                    void fetchRedeemCodes({ status: redeemStatusFilter, mode: next });
                  }}
                  className="h-9 rounded-xl border border-zinc-300 px-3 text-sm bg-white"
                >
                  <option value="all">全部类型</option>
                  <option value="universal">通用码</option>
                  <option value="bound">专属码</option>
                </select>
                <button
                  onClick={() => void fetchRedeemCodes()}
                  className="h-9 px-3 rounded-xl border border-zinc-300 bg-white hover:bg-zinc-50 text-sm"
                >
                  刷新
                </button>
              </div>
            </div>

            <div className="max-h-[620px] overflow-auto rounded-xl border border-zinc-200 bg-white">
              {redeemCodeLoading ? (
                <div className="p-4 text-sm text-zinc-500">兑换码加载中...</div>
              ) : redeemCodeRows.length === 0 ? (
                <div className="p-4 text-sm text-zinc-500">暂无兑换码记录</div>
              ) : (
                <table className="min-w-[1180px] w-full table-fixed text-xs">
                  <thead className="sticky top-0 bg-zinc-50 z-10">
                    <tr className="text-zinc-600 border-b border-zinc-200">
                      <th className="text-left px-3 py-2 w-[150px]">兑换码</th>
                      <th className="text-left px-3 py-2 w-[80px]">类型</th>
                      <th className="text-left px-3 py-2 w-[90px]">状态</th>
                      <th className="text-left px-3 py-2 w-[100px]">积分</th>
                      <th className="text-left px-3 py-2 w-[110px]">使用次数</th>
                      <th className="text-left px-3 py-2 w-[170px]">绑定用户</th>
                      <th className="text-left px-3 py-2 w-[190px]">创建信息</th>
                      <th className="text-left px-3 py-2 w-[180px]">过期 / 使用</th>
                      <th className="text-left px-3 py-2 w-[300px]">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {redeemCodeRows.map((row) => (
                      <tr key={row.id} className="border-b border-zinc-100 align-top">
                        <td className="px-3 py-2 font-medium text-zinc-800 truncate">{row.codePreview}</td>
                        <td className="px-3 py-2 text-zinc-700">{row.mode === 'bound' ? '专属码' : '通用码'}</td>
                        <td className="px-3 py-2">
                          <span className="px-2 py-0.5 rounded border border-zinc-200 bg-zinc-50 text-zinc-700">{getRedeemStatusLabel(row.status)}</span>
                        </td>
                        <td className="px-3 py-2 text-zinc-700">{row.points} 积分</td>
                        <td className="px-3 py-2 text-zinc-700">{row.usedCount}/{row.maxUses}</td>
                        <td className="px-3 py-2 text-zinc-700 truncate">{row.boundUser ? `${row.boundUser.account} / ${row.boundUser.username}` : '无'}</td>
                        <td className="px-3 py-2 text-zinc-600">
                          <div className="truncate">{row.createdByUser.account}</div>
                          <div className="truncate">{new Date(row.createdAt).toLocaleString()}</div>
                        </td>
                        <td className="px-3 py-2 text-zinc-600">
                          <div className="truncate">过期：{row.expiresAt ? new Date(row.expiresAt).toLocaleString() : '不过期'}</div>
                          <div className="truncate">使用：{row.usedByUser ? `${row.usedByUser.account}` : '未使用'}</div>
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap items-center gap-2">
                            {row.status === 'active' ? (
                              <button
                                onClick={() => void revokeRedeemCode(row.id)}
                                className="h-7 px-2 rounded-lg border border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100"
                              >
                                撤销
                              </button>
                            ) : null}
                            {row.mode === 'universal' ? (
                              <>
                                <div className="h-7 w-28 rounded-lg border border-zinc-200 px-2 text-xs flex items-center gap-1">
                                  <input
                                    value={redeemRowMaxUses[row.id] ?? String(row.maxUses)}
                                    onChange={(e) => setRedeemRowMaxUses((prev) => ({
                                      ...prev,
                                      [row.id]: e.target.value.replace(/[^\d]/g, ''),
                                    }))}
                                    className="w-full bg-transparent outline-none"
                                    placeholder="次数"
                                  />
                                  <span className="text-zinc-500">次</span>
                                </div>
                                <button
                                  onClick={() => void updateRedeemCodeUsageLimit(row)}
                                  className="h-7 px-2 rounded-lg border border-zinc-300 bg-white hover:bg-zinc-50"
                                >
                                  更新次数
                                </button>
                              </>
                            ) : null}
                            {row.note ? <span className="text-zinc-500 truncate max-w-[160px]">备注：{row.note}</span> : null}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
        )}

        {adminSection === 'users' && (
        <div className="grid grid-cols-1 xl:grid-cols-[360px_1fr] gap-5">
          <div className="bg-white border border-zinc-200 rounded-2xl p-5 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h2 className="text-lg font-semibold">用户列表</h2>
                <p className="text-xs text-zinc-500 mt-1">支持按账号、用户名、任务状态筛选。</p>
              </div>
              <div className="text-xs text-zinc-500">
                {!keyword.trim() && userTaskStatusFilter === 'all'
                  ? `总用户：${userAllTotal}`
                  : `筛选结果：${userFilteredTotal}${userAllTotal > 0 ? ` / 总用户：${userAllTotal}` : ''}`}
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2 text-xs">
              <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-2 py-1.5 text-zinc-600">当前列表：{users.length}</div>
              <div className="rounded-lg border border-rose-200 bg-rose-50 px-2 py-1.5 text-rose-700">任务暂停：{blockedUserCount}</div>
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-2 py-1.5 text-emerald-700">任务正常：{normalUserCount}</div>
            </div>

            <div className="space-y-2">
              <input
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder="按账号或用户名搜索"
                className="h-10 w-full rounded-xl border border-zinc-200 px-3 text-sm"
              />
              <div className="flex items-center gap-2">
                <select
                  value={userTaskStatusFilter}
                  onChange={(e) => {
                    const nextStatus = e.target.value as UserTaskStatusFilter;
                    setUserTaskStatusFilter(nextStatus);
                    void fetchUsers(keyword, nextStatus);
                  }}
                  className="h-10 min-w-0 flex-1 rounded-xl border border-zinc-200 px-3 text-sm"
                >
                  <option value="all">全部任务状态</option>
                  <option value="blocked">仅任务已暂停</option>
                  <option value="normal">仅任务正常</option>
                </select>
                <button
                  onClick={() => fetchUsers(keyword, userTaskStatusFilter)}
                  className="h-10 px-4 rounded-xl bg-zinc-900 text-white hover:bg-zinc-800 shrink-0"
                >
                  搜索
                </button>
              </div>
            </div>

            <div className="max-h-[420px] overflow-auto border border-zinc-200 rounded-xl">
              {userLoading ? (
                <div className="p-4 text-sm text-zinc-500">加载中...</div>
              ) : users.length === 0 ? (
                <div className="p-4 text-sm text-zinc-500">暂无用户</div>
              ) : (
              <div className="divide-y divide-zinc-100">
                  {users.map((user) => (
                    <button
                      key={user.id}
                      onClick={() => setSelectedUserId(user.id)}
                      className={`w-full text-left p-3 hover:bg-zinc-50 ${selectedUserId === user.id ? 'bg-[#eef3ff]' : ''}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-sm font-medium text-zinc-800">{user.username}（{user.account}）</div>
                        <span className={`px-2 py-0.5 rounded border text-[10px] ${user.taskBlocked ? 'border-rose-200 bg-rose-50 text-rose-700' : 'border-emerald-200 bg-emerald-50 text-emerald-700'}`}>
                          {user.taskBlocked ? '任务已暂停' : '任务正常'}
                        </span>
                      </div>
                      <div className="text-xs text-zinc-500 mt-1">积分 {user.points} · 角色 {user.role}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="bg-white border border-zinc-200 rounded-2xl p-5 space-y-4">
            <h2 className="text-lg font-semibold">用户运营操作</h2>
            {!selectedUser ? (
              <div className="text-sm text-zinc-500">请先在左侧选择一个用户</div>
            ) : (
              <>
                <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-700 space-y-1">
                  <div>用户：{selectedUser.username}</div>
                  <div>账号：{selectedUser.account}</div>
                  <div>当前积分：{selectedUser.points}</div>
                  <div>任务状态：{selectedUser.taskBlocked ? '已暂停' : '正常'}</div>
                </div>

                <div className="rounded-xl border border-zinc-200 p-3 space-y-2">
                  <div className="text-sm font-medium text-zinc-700">积分调账（补偿/扣减）</div>
                  <input
                    value={deltaInput}
                    onChange={(e) => setDeltaInput(e.target.value.replace(/[^\d-]/g, ''))}
                    placeholder="例如：50（补分）或 -20（扣分）"
                    className="h-10 w-full rounded-xl border border-zinc-200 px-3 text-sm"
                  />
                  <input
                    value={reasonInput}
                    onChange={(e) => setReasonInput(e.target.value)}
                    placeholder="填写原因，如：异常扣费补偿"
                    className="h-10 w-full rounded-xl border border-zinc-200 px-3 text-sm"
                  />
                  <button
                    onClick={adjustSelectedUserPoints}
                    className="h-10 px-4 rounded-xl bg-zinc-900 text-white hover:bg-zinc-800 text-sm font-semibold"
                  >
                    提交调账
                  </button>
                </div>

                <div className="rounded-xl border border-zinc-200 p-3">
                  <div className="text-sm font-medium text-zinc-700 mb-2">任务开关（仅当前用户）</div>
                  <button
                    onClick={toggleSelectedUserTaskBlock}
                    className={`h-10 px-4 rounded-xl text-sm font-semibold ${
                      selectedUser.taskBlocked
                        ? 'bg-zinc-900 text-white hover:bg-zinc-800'
                        : 'bg-rose-600 text-white hover:bg-rose-700'
                    }`}
                  >
                    {selectedUser.taskBlocked ? '恢复该用户任务' : '暂停该用户任务'}
                  </button>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                  <div className="rounded-xl border border-zinc-200 p-3">
                    <div className="text-sm font-medium text-zinc-700 mb-2">最近积分流水</div>
                    <div className="max-h-44 overflow-auto rounded-xl border border-zinc-200">
                      {selectedUserLogs.length === 0 ? (
                        <div className="p-3 text-xs text-zinc-500">暂无数据</div>
                      ) : (
                        selectedUserLogs.map((log) => (
                          <div key={log.id} className="p-2 text-xs border-b border-zinc-100">
                            <div className={log.delta >= 0 ? 'text-emerald-700' : 'text-rose-700'}>
                              {log.delta >= 0 ? '+' : ''}{log.delta} · 余额 {log.balanceAfter}
                            </div>
                            <div className="text-zinc-600">{log.reason}</div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  <div className="rounded-xl border border-zinc-200 p-3">
                    <div className="text-sm font-medium text-zinc-700 mb-2">最近积分订单</div>
                    <div className="max-h-44 overflow-auto rounded-xl border border-zinc-200">
                      {selectedUserOrders.length === 0 ? (
                        <div className="p-3 text-xs text-zinc-500">暂无数据</div>
                      ) : (
                        selectedUserOrders.map((order) => (
                          <div key={order.id} className="p-2 text-xs border-b border-zinc-100">
                            <div className="text-zinc-700">{order.orderNo} · {order.channel}</div>
                            <div className="text-zinc-600">
                              金额 ¥{(order.amountFen / 100).toFixed(2)} · 积分 {order.points} · 状态 {order.status}
                            </div>
                            {order.gatewayStatus || order.refundStatus ? (
                              <div className="text-zinc-500 mt-1">
                                {order.gatewayStatus ? `渠道 ${order.gatewayStatus}` : ''}
                                {order.gatewayStatus && order.refundStatus ? ' · ' : ''}
                                {order.refundStatus ? `退款 ${order.refundStatus}` : ''}
                              </div>
                            ) : null}
                            {order.channel === 'wechat' && order.status === 'credited' ? (
                              <button
                                type="button"
                                onClick={() => void refundPaymentOrder(order)}
                                className="mt-2 h-7 px-2 rounded-lg border border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100 text-[11px]"
                              >
                                人工退款
                              </button>
                            ) : null}
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  <div className="rounded-xl border border-zinc-200 p-3 lg:col-span-2">
                    <div className="text-sm font-medium text-zinc-700 mb-2">风控告警（最近20条）</div>
                    <div className="max-h-44 overflow-auto rounded-xl border border-zinc-200">
                      {selectedUserSecurityEvents.length === 0 ? (
                        <div className="p-3 text-xs text-zinc-500">暂无风险告警</div>
                      ) : (
                        selectedUserSecurityEvents.map((item) => (
                          <div key={item.id} className="p-2 text-xs border-b border-zinc-100">
                            <div className="text-zinc-800 font-medium">{item.detail}</div>
                            <div className="text-zinc-500 mt-1">
                              {new Date(item.createdAt).toLocaleString()}
                              {item.ip ? ` · IP ${item.ip}` : ''}
                              {item.route ? ` · ${item.route}` : ''}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
        )}

        {adminSection === 'tasks' && (
        <div className="bg-white border border-zinc-200 rounded-2xl p-5 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">任务监控</h2>
              <p className="text-xs text-zinc-500 mt-1">按状态、账号、错误关键词定位问题任务，并快速跳转用户处理。</p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  void fetchTaskStats();
                  void fetchTasks({
                    status: taskStatusFilter,
                    account: taskAccountFilter,
                    keyword: taskKeywordFilter,
                    anomalyOnly: taskAnomalyOnly,
                    anomalyType: taskAnomalyType,
                    from: taskFrom,
                    to: taskTo,
                    includeHidden: taskIncludeHidden,
                  });
                }}
                className="h-9 px-3 rounded-xl border border-zinc-300 bg-white hover:bg-zinc-50 text-sm"
              >
                刷新
              </button>
              <button
                onClick={exportTasksCsv}
                className="h-9 px-3 rounded-xl border border-zinc-300 bg-white hover:bg-zinc-50 text-sm"
              >
                导出 CSV
              </button>
            </div>
          </div>

          <div className="rounded-xl border border-zinc-200 p-3 space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
              <div className="space-y-1">
                <div className="text-xs text-zinc-500">任务状态</div>
                <select
                  value={taskStatusFilter}
                  onChange={(e) => setTaskStatusFilter(e.target.value)}
                  className="h-10 w-full rounded-xl border border-zinc-200 px-3 text-sm"
                >
                  <option value="">全部状态</option>
                  <option value="queueing">排队中</option>
                  <option value="submitting">提交中</option>
                  <option value="running">执行中</option>
                  <option value="success">已成功</option>
                  <option value="failed">已失败</option>
                  <option value="timeout">已超时</option>
                  <option value="cancelled">已取消</option>
                </select>
              </div>
              <div className="space-y-1">
                <div className="text-xs text-zinc-500">账号筛选</div>
                <input
                  value={taskAccountFilter}
                  onChange={(e) => setTaskAccountFilter(e.target.value)}
                  placeholder="输入用户账号"
                  className="h-10 w-full rounded-xl border border-zinc-200 px-3 text-sm"
                />
              </div>
              <div className="space-y-1">
                <div className="text-xs text-zinc-500">关键词</div>
                <input
                  value={taskKeywordFilter}
                  onChange={(e) => setTaskKeywordFilter(e.target.value)}
                  placeholder="请求ID / 错误信息"
                  className="h-10 w-full rounded-xl border border-zinc-200 px-3 text-sm"
                />
              </div>
              <div className="space-y-1">
                <div className="text-xs text-zinc-500">查询动作</div>
                <button
                  onClick={() => void fetchTasks({
                    status: taskStatusFilter,
                    account: taskAccountFilter,
                    keyword: taskKeywordFilter,
                    anomalyOnly: taskAnomalyOnly,
                    anomalyType: taskAnomalyType,
                    from: taskFrom,
                    to: taskTo,
                    includeHidden: taskIncludeHidden,
                  })}
                  className="h-10 w-full rounded-xl bg-zinc-900 text-white hover:bg-zinc-800 text-sm"
                >
                  查询任务
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
              <div className="space-y-1">
                <div className="text-xs text-zinc-500">开始时间</div>
                <input
                  type="datetime-local"
                  value={taskFrom}
                  onChange={(e) => setTaskFrom(e.target.value)}
                  className="h-10 w-full rounded-xl border border-zinc-200 px-3 text-sm"
                />
              </div>
              <div className="space-y-1">
                <div className="text-xs text-zinc-500">结束时间</div>
                <input
                  type="datetime-local"
                  value={taskTo}
                  onChange={(e) => setTaskTo(e.target.value)}
                  className="h-10 w-full rounded-xl border border-zinc-200 px-3 text-sm"
                />
              </div>
              <label className="h-10 rounded-xl border border-zinc-200 px-3 text-sm inline-flex items-center gap-2 bg-white mt-6 md:mt-0">
                <input
                  type="checkbox"
                  checked={taskAnomalyOnly}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setTaskAnomalyOnly(checked);
                    if (!checked) setTaskAnomalyType('');
                  }}
                />
                仅看异常
              </label>
              <label className="h-10 rounded-xl border border-zinc-200 px-3 text-sm inline-flex items-center gap-2 bg-white mt-6 md:mt-0">
                <input
                  type="checkbox"
                  checked={taskIncludeHidden}
                  onChange={(e) => setTaskIncludeHidden(e.target.checked)}
                />
                显示已隐藏
              </label>
            </div>

            {taskAnomalyOnly ? (
              <div className="flex flex-wrap gap-2 text-xs pt-1">
                {[
                  { key: '', label: '全部异常' },
                  { key: 'failed', label: '任务失败' },
                  { key: 'timeout', label: '任务超时' },
                  { key: 'delivery', label: '投递失败' },
                  { key: 'alert', label: '系统告警' },
                  { key: 'execution', label: '执行异常' },
                ].map((item) => (
                  <button
                    key={item.key || 'all'}
                    onClick={() => applyAnomalyTypeFilter(item.key)}
                    className={`h-7 px-2.5 rounded-lg border ${
                      taskAnomalyType === item.key
                        ? 'border-zinc-900 bg-zinc-900 text-white'
                        : 'border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50'
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          {taskStats ? (
            <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-sm">
              <div className="rounded-xl border border-zinc-200 p-3 bg-zinc-50">总任务：{taskStats.total}</div>
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-emerald-700">成功：{taskStats.success}</div>
              <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-rose-700">失败：{taskStats.failed}</div>
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-amber-700">投递失败：{taskStats.deliveryFailed}</div>
              <div className="rounded-xl border border-zinc-200 p-3 bg-zinc-50">成功率：{taskStats.successRate}%</div>
            </div>
          ) : null}

          <div className="max-h-[420px] overflow-auto rounded-xl border border-zinc-200 bg-white">
            {taskLoading ? (
              <div className="p-4 text-sm text-zinc-500">任务加载中...</div>
            ) : taskRows.length === 0 ? (
              <div className="p-4 text-sm text-zinc-500">暂无任务数据</div>
            ) : (
              <table className="min-w-[1180px] w-full table-fixed text-xs">
                <thead className="sticky top-0 bg-zinc-50 z-10">
                  <tr className="border-b border-zinc-200 text-zinc-600">
                    <th className="text-left px-3 py-2 w-[220px]">任务</th>
                    <th className="text-left px-3 py-2 w-[240px]">状态与标签</th>
                    <th className="text-left px-3 py-2 w-[260px]">账号与请求</th>
                    <th className="text-left px-3 py-2 w-[320px]">错误信息</th>
                    <th className="text-left px-3 py-2 w-[140px]">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {taskRows.map((row) => (
                    <tr key={row.id} className="border-b border-zinc-100 align-top">
                      <td className="px-3 py-2">
                        <div className="font-medium text-zinc-800 truncate">{row.workflowTitle || row.workflowId}</div>
                        <div className="text-zinc-500 truncate mt-1">时间：{new Date(row.createdAt).toLocaleString()}</div>
                      </td>
                      <td className="px-3 py-2">
                        <div className="text-zinc-700">{row.status} · 投递 {row.deliveryStatus || 'none'}{row.hiddenAt ? ' · 已隐藏' : ''}</div>
                        <div className="flex flex-wrap gap-1.5 mt-1">
                          {getAnomalyTags(row).map((tag) => (
                            <button
                              key={`${row.id}-${tag.label}`}
                              onClick={() => applyAnomalyTypeFilter(tag.filterKey)}
                              className={
                                tag.tone === 'rose'
                                  ? `inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] ${taskAnomalyOnly && taskAnomalyType === tag.filterKey ? 'border-rose-400 bg-rose-100 text-rose-800' : 'border-rose-200 bg-rose-50 text-rose-700'}`
                                  : tag.tone === 'amber'
                                    ? `inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] ${taskAnomalyOnly && taskAnomalyType === tag.filterKey ? 'border-amber-400 bg-amber-100 text-amber-800' : 'border-amber-200 bg-amber-50 text-amber-700'}`
                                    : `inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] ${taskAnomalyOnly && taskAnomalyType === tag.filterKey ? 'border-indigo-400 bg-indigo-100 text-indigo-800' : 'border-indigo-200 bg-indigo-50 text-indigo-700'}`
                              }
                              title="点击按该异常类型过滤"
                            >
                              {tag.label}
                            </button>
                          ))}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-zinc-600">
                        <div className="truncate">账号：{row.user.account}</div>
                        <div className="truncate mt-1">请求：{row.requestId}</div>
                      </td>
                      <td className="px-3 py-2">
                        {row.error ? (
                          <div className={`${row.error.startsWith('告警：') ? 'text-amber-700' : 'text-rose-600'} truncate`}>
                            {row.error.startsWith('告警：') ? row.error : `错误：${row.error}`}
                          </div>
                        ) : (
                          <div className="text-zinc-400">无</div>
                        )}
                        {row.deliveryLastError ? <div className="text-amber-600 truncate mt-1">投递：{row.deliveryLastError}</div> : null}
                      </td>
                      <td className="px-3 py-2">
                        <button
                          onClick={() => void locateUserFromTask(row)}
                          className="h-7 px-2 rounded-lg border border-zinc-300 bg-white hover:bg-zinc-50 text-[11px]"
                        >
                          定位用户
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
        )}
      </div>
    </div>
  );
}
