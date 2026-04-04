'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Toaster, toast } from 'sonner';
import { workflows } from '@/lib/workflows';

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
  thirdTradeNo: string | null;
  paidAt: string | null;
  createdAt: string;
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
};

export default function AdminPage() {
  const [loading, setLoading] = useState(true);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [verified, setVerified] = useState(false);

  const [globalStopEnabled, setGlobalStopEnabled] = useState(false);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [keyword, setKeyword] = useState('');
  const [userLoading, setUserLoading] = useState(false);

  const [selectedUserId, setSelectedUserId] = useState('');
  const [deltaInput, setDeltaInput] = useState('');
  const [reasonInput, setReasonInput] = useState('');
  const [selectedUserLogs, setSelectedUserLogs] = useState<UserPointLog[]>([]);
  const [selectedUserOrders, setSelectedUserOrders] = useState<UserOrder[]>([]);
  const [taskStatusFilter, setTaskStatusFilter] = useState('');
  const [taskAccountFilter, setTaskAccountFilter] = useState('');
  const [taskKeywordFilter, setTaskKeywordFilter] = useState('');
  const [taskFrom, setTaskFrom] = useState('');
  const [taskTo, setTaskTo] = useState('');
  const [taskIncludeHidden, setTaskIncludeHidden] = useState(false);
  const [taskRows, setTaskRows] = useState<AdminTaskRow[]>([]);
  const [taskStats, setTaskStats] = useState<AdminTaskStats | null>(null);
  const [taskLoading, setTaskLoading] = useState(false);
  const [queueConfig, setQueueConfig] = useState<QueueConfig | null>(null);
  const [queueConfigLoading, setQueueConfigLoading] = useState(false);

  const selectedUser = useMemo(
    () => users.find((user) => user.id === selectedUserId) || null,
    [users, selectedUserId]
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

  const fetchUsers = useCallback(async (search: string) => {
    setUserLoading(true);
    try {
      const response = await fetch(
        `/api/admin/users?keyword=${encodeURIComponent(search)}&page=1&pageSize=50`,
        { cache: 'no-store' }
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.success) {
        toast.error(data?.message || '查询用户失败');
        return;
      }

      const list: AdminUser[] = Array.isArray(data.data?.users) ? data.data.users : [];
      setUsers(list);

      if (list.length > 0 && !list.some((u) => u.id === selectedUserId)) {
        setSelectedUserId(list[0].id);
      }
      if (list.length === 0) {
        setSelectedUserId('');
      }
    } finally {
      setUserLoading(false);
    }
  }, [selectedUserId]);

  const fetchSelectedUserSummary = async (userId: string) => {
    if (!userId) {
      setSelectedUserLogs([]);
      setSelectedUserOrders([]);
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
      setQueueConfig(data.data as QueueConfig);
    } finally {
      setQueueConfigLoading(false);
    }
  }, []);

  const saveQueueConfig = async () => {
    if (!queueConfig) return;
    const response = await fetch('/api/admin/system/queue-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(queueConfig),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data?.success) {
      toast.error(data?.message || '保存队列配置失败');
      return;
    }
    setQueueConfig(data.data as QueueConfig);
    toast.success('队列配置已保存');
  };

  const fetchTasks = useCallback(async (filters?: {
    status?: string;
    account?: string;
    keyword?: string;
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
      const from = filters?.from ?? taskFrom;
      const to = filters?.to ?? taskTo;
      const includeHidden = filters?.includeHidden ?? taskIncludeHidden;
      if (status) params.set('status', status);
      if (account) params.set('account', account);
      if (keyword) params.set('keyword', keyword);
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
  }, [taskAccountFilter, taskFrom, taskIncludeHidden, taskKeywordFilter, taskStatusFilter, taskTo]);

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
          fetchUsers(''),
          fetchTaskStats(),
          fetchQueueConfig(),
          fetchTasks({ status: '', account: '', keyword: '', includeHidden: false }),
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
  }, [fetchQueueConfig, fetchTaskStats, fetchTasks, fetchUsers]);

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

        <div className="bg-white border border-zinc-200 rounded-2xl p-5 space-y-3">
          <h2 className="text-lg font-semibold">系统控制</h2>
          <p className="text-sm text-zinc-500">
            全局紧急停机：开启后所有用户都无法新建任务；关闭后恢复。当前状态：
            <span className={globalStopEnabled ? 'text-rose-600' : 'text-emerald-600'}>
              {globalStopEnabled ? '已开启' : '已关闭'}
            </span>
          </p>
          <div className="flex items-center gap-3">
            <button
              onClick={() => toggleGlobalStop(true)}
              className="px-4 py-2 rounded-xl border border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100"
            >
              开启全局紧急停机
            </button>
            <button
              onClick={() => toggleGlobalStop(false)}
              className="px-4 py-2 rounded-xl border border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
            >
              关闭全局紧急停机
            </button>
          </div>
        </div>

        <div className="bg-white border border-zinc-200 rounded-2xl p-5 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">队列策略配置</h2>
            <div className="flex items-center gap-2">
              <button
                onClick={() => void fetchQueueConfig()}
                className="h-9 px-3 rounded-xl border border-zinc-300 bg-white hover:bg-zinc-50 text-sm"
              >
                刷新
              </button>
              <button
                onClick={() => void saveQueueConfig()}
                className="h-9 px-3 rounded-xl bg-zinc-900 text-white hover:bg-zinc-800 text-sm"
              >
                保存配置
              </button>
            </div>
          </div>

          {!queueConfig || queueConfigLoading ? (
            <div className="text-sm text-zinc-500">加载中...</div>
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
                <input
                  type="number"
                  min={1}
                  value={Math.round(queueConfig.timeoutDefaults.imageMs / 60000)}
                  onChange={(e) => setQueueConfig((prev) => prev ? {
                    ...prev,
                    timeoutDefaults: {
                      ...prev.timeoutDefaults,
                      imageMs: Math.max(1, Number(e.target.value || 1)) * 60 * 1000,
                    },
                  } : prev)}
                  className="h-10 rounded-xl border border-zinc-200 px-3 text-sm"
                  placeholder="图像超时(分钟)"
                />
                <input
                  type="number"
                  min={1}
                  value={Math.round(queueConfig.timeoutDefaults.audioMs / 60000)}
                  onChange={(e) => setQueueConfig((prev) => prev ? {
                    ...prev,
                    timeoutDefaults: {
                      ...prev.timeoutDefaults,
                      audioMs: Math.max(1, Number(e.target.value || 1)) * 60 * 1000,
                    },
                  } : prev)}
                  className="h-10 rounded-xl border border-zinc-200 px-3 text-sm"
                  placeholder="音频超时(分钟)"
                />
                <input
                  type="number"
                  min={1}
                  value={Math.round(queueConfig.timeoutDefaults.videoMs / 60000)}
                  onChange={(e) => setQueueConfig((prev) => prev ? {
                    ...prev,
                    timeoutDefaults: {
                      ...prev.timeoutDefaults,
                      videoMs: Math.max(1, Number(e.target.value || 1)) * 60 * 1000,
                    },
                  } : prev)}
                  className="h-10 rounded-xl border border-zinc-200 px-3 text-sm"
                  placeholder="视频超时(分钟)"
                />
                <input
                  type="number"
                  min={1}
                  value={Math.round(queueConfig.heartbeatToleranceMs / 60000)}
                  onChange={(e) => setQueueConfig((prev) => prev ? {
                    ...prev,
                    heartbeatToleranceMs: Math.max(1, Number(e.target.value || 1)) * 60 * 1000,
                  } : prev)}
                  className="h-10 rounded-xl border border-zinc-200 px-3 text-sm"
                  placeholder="心跳容错(分钟)"
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-4 gap-2 text-sm">
                <select
                  value={queueConfig.refundPolicy.payloadInvalid}
                  onChange={(e) => setQueueConfig((prev) => prev ? {
                    ...prev,
                    refundPolicy: {
                      ...prev.refundPolicy,
                      payloadInvalid: e.target.value === 'none' ? 'none' : 'full',
                    },
                  } : prev)}
                  className="h-10 rounded-xl border border-zinc-200 px-3"
                >
                  <option value="full">参数失败返还全额</option>
                  <option value="none">参数失败不返还</option>
                </select>
                <select
                  value={queueConfig.refundPolicy.submitFailed}
                  onChange={(e) => setQueueConfig((prev) => prev ? {
                    ...prev,
                    refundPolicy: {
                      ...prev.refundPolicy,
                      submitFailed: e.target.value === 'none' ? 'none' : 'full',
                    },
                  } : prev)}
                  className="h-10 rounded-xl border border-zinc-200 px-3"
                >
                  <option value="full">提交失败返还全额</option>
                  <option value="none">提交失败不返还</option>
                </select>
                <select
                  value={queueConfig.refundPolicy.taskFailed}
                  onChange={(e) => setQueueConfig((prev) => prev ? {
                    ...prev,
                    refundPolicy: {
                      ...prev.refundPolicy,
                      taskFailed: e.target.value === 'none' ? 'none' : 'full',
                    },
                  } : prev)}
                  className="h-10 rounded-xl border border-zinc-200 px-3"
                >
                  <option value="full">执行失败返还全额</option>
                  <option value="none">执行失败不返还</option>
                </select>
                <select
                  value={queueConfig.refundPolicy.taskTimeout}
                  onChange={(e) => setQueueConfig((prev) => prev ? {
                    ...prev,
                    refundPolicy: {
                      ...prev.refundPolicy,
                      taskTimeout: e.target.value === 'none' ? 'none' : 'full',
                    },
                  } : prev)}
                  className="h-10 rounded-xl border border-zinc-200 px-3"
                >
                  <option value="full">任务超时返还全额</option>
                  <option value="none">任务超时不返还</option>
                </select>
              </div>

              <div className="rounded-xl border border-zinc-200 p-3">
                <div className="text-sm font-medium text-zinc-700 mb-2">按工作流覆盖超时（分钟）</div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {workflows.map((workflow) => (
                    <label key={workflow.workflowId} className="flex items-center justify-between gap-3 text-xs border border-zinc-100 rounded-lg px-2 py-2">
                      <span className="text-zinc-700">{workflow.title}</span>
                      <input
                        type="number"
                        min={1}
                        value={
                          queueConfig.workflowTimeoutOverrides[workflow.workflowId]
                            ? Math.round(queueConfig.workflowTimeoutOverrides[workflow.workflowId] / 60000)
                            : Math.round(workflow.maxWaitMs / 60000)
                        }
                        onChange={(e) => {
                          const minutes = Math.max(1, Number(e.target.value || 1));
                          setQueueConfig((prev) => {
                            if (!prev) return prev;
                            return {
                              ...prev,
                              workflowTimeoutOverrides: {
                                ...prev.workflowTimeoutOverrides,
                                [workflow.workflowId]: minutes * 60 * 1000,
                              },
                            };
                          });
                        }}
                        className="h-8 w-20 rounded-md border border-zinc-200 px-2 text-right"
                      />
                    </label>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <div className="bg-white border border-zinc-200 rounded-2xl p-5 space-y-3">
            <h2 className="text-lg font-semibold">用户列表</h2>
            <div className="flex items-center gap-2">
              <input
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder="按账号或用户名搜索"
                className="h-10 flex-1 rounded-xl border border-zinc-200 px-3 text-sm"
              />
              <button
                onClick={() => fetchUsers(keyword)}
                className="h-10 px-4 rounded-xl bg-zinc-900 text-white hover:bg-zinc-800"
              >
                搜索
              </button>
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
                      <div className="text-sm font-medium text-zinc-800">{user.username}（{user.account}）</div>
                      <div className="text-xs text-zinc-500 mt-1">
                        积分 {user.points} · {user.taskBlocked ? '任务已暂停' : '任务正常'} · {user.role}
                      </div>
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
                <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-700">
                  <div>用户：{selectedUser.username}</div>
                  <div>账号：{selectedUser.account}</div>
                  <div>当前积分：{selectedUser.points}</div>
                  <div>任务状态：{selectedUser.taskBlocked ? '已暂停' : '正常'}</div>
                </div>

                <div className="space-y-2">
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
                    className="h-10 px-4 rounded-xl bg-gradient-to-r from-[#dde9ff] to-[#f9efff] text-[#266eff] text-sm font-semibold"
                  >
                    提交调账
                  </button>
                </div>

                <div className="pt-2 border-t border-zinc-200">
                  <div className="text-sm font-medium text-zinc-700 mb-2">任务开关（仅当前用户）</div>
                  <button
                    onClick={toggleSelectedUserTaskBlock}
                    className={`h-10 px-4 rounded-xl text-sm font-semibold ${
                      selectedUser.taskBlocked
                        ? 'border border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                        : 'border border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100'
                    }`}
                  >
                    {selectedUser.taskBlocked ? '恢复该用户任务' : '暂停该用户任务'}
                  </button>
                </div>

                <div className="pt-3 border-t border-zinc-200 space-y-3">
                  <div>
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

                  <div>
                    <div className="text-sm font-medium text-zinc-700 mb-2">最近充值订单</div>
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

        <div className="bg-white border border-zinc-200 rounded-2xl p-5 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">任务筛选与统计</h2>
            <button
              onClick={() => {
                void fetchTaskStats();
                void fetchTasks({
                  status: taskStatusFilter,
                  account: taskAccountFilter,
                  keyword: taskKeywordFilter,
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

          <div className="grid grid-cols-1 md:grid-cols-7 gap-2">
            <select
              value={taskStatusFilter}
              onChange={(e) => setTaskStatusFilter(e.target.value)}
              className="h-10 rounded-xl border border-zinc-200 px-3 text-sm"
            >
              <option value="">全部状态</option>
              <option value="queueing">queueing</option>
              <option value="submitting">submitting</option>
              <option value="running">running</option>
              <option value="success">success</option>
              <option value="failed">failed</option>
              <option value="timeout">timeout</option>
              <option value="cancelled">cancelled</option>
            </select>
            <input
              value={taskAccountFilter}
              onChange={(e) => setTaskAccountFilter(e.target.value)}
              placeholder="账号筛选"
              className="h-10 rounded-xl border border-zinc-200 px-3 text-sm"
            />
            <input
              value={taskKeywordFilter}
              onChange={(e) => setTaskKeywordFilter(e.target.value)}
              placeholder="关键词/请求ID/错误"
              className="h-10 rounded-xl border border-zinc-200 px-3 text-sm"
            />
            <input
              type="datetime-local"
              value={taskFrom}
              onChange={(e) => setTaskFrom(e.target.value)}
              className="h-10 rounded-xl border border-zinc-200 px-3 text-sm"
            />
            <input
              type="datetime-local"
              value={taskTo}
              onChange={(e) => setTaskTo(e.target.value)}
              className="h-10 rounded-xl border border-zinc-200 px-3 text-sm"
            />
            <label className="h-10 rounded-xl border border-zinc-200 px-3 text-sm inline-flex items-center gap-2 bg-white">
              <input
                type="checkbox"
                checked={taskIncludeHidden}
                onChange={(e) => setTaskIncludeHidden(e.target.checked)}
              />
              显示已隐藏
            </label>
            <button
              onClick={() => void fetchTasks({
                status: taskStatusFilter,
                account: taskAccountFilter,
                keyword: taskKeywordFilter,
                from: taskFrom,
                to: taskTo,
                includeHidden: taskIncludeHidden,
              })}
              className="h-10 rounded-xl bg-zinc-900 text-white hover:bg-zinc-800 text-sm"
            >
              查询
            </button>
          </div>

          {taskStats ? (
            <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-sm">
              <div className="rounded-xl border border-zinc-200 p-3">总任务：{taskStats.total}</div>
              <div className="rounded-xl border border-zinc-200 p-3 text-emerald-700">成功：{taskStats.success}</div>
              <div className="rounded-xl border border-zinc-200 p-3 text-rose-700">失败：{taskStats.failed}</div>
              <div className="rounded-xl border border-zinc-200 p-3 text-amber-700">投递失败：{taskStats.deliveryFailed}</div>
              <div className="rounded-xl border border-zinc-200 p-3">成功率：{taskStats.successRate}%</div>
            </div>
          ) : null}

          <div className="max-h-[380px] overflow-auto rounded-xl border border-zinc-200">
            {taskLoading ? (
              <div className="p-4 text-sm text-zinc-500">任务加载中...</div>
            ) : taskRows.length === 0 ? (
              <div className="p-4 text-sm text-zinc-500">暂无任务数据</div>
            ) : (
              <div className="divide-y divide-zinc-100">
                {taskRows.map((row) => (
                  <div key={row.id} className="p-3 text-xs">
                    <div className="text-zinc-800 font-medium">
                      {row.workflowTitle || row.workflowId} · {row.status} · 投递 {row.deliveryStatus || 'none'}{row.hiddenAt ? ' · 已隐藏' : ''}
                    </div>
                    <div className="text-zinc-600 mt-1">
                      账号 {row.user.account} · 请求 {row.requestId} · 时间 {new Date(row.createdAt).toLocaleString()}
                    </div>
                    {row.error ? (
                      <div className={`mt-1 ${row.error.startsWith('告警：') ? 'text-amber-700' : 'text-rose-600'}`}>
                        {row.error.startsWith('告警：') ? row.error : `错误：${row.error}`}
                      </div>
                    ) : null}
                    {row.deliveryLastError ? <div className="text-amber-600 mt-1">投递：{row.deliveryLastError}</div> : null}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
