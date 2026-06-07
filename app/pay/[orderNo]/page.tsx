'use client';

import Link from 'next/link';
import QRCode from 'qrcode';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Toaster, toast } from 'sonner';
import { refreshUserBalance } from '@/lib/user-balance-store';

type OrderStatus = 'pending' | 'paid' | 'credited' | 'closed' | 'failed' | 'refund_pending' | 'refunded' | string;
type PayChannel = 'wechat' | 'alipay';

type PayOrder = {
  orderNo: string;
  channel: PayChannel;
  amountFen: number;
  points: number;
  status: OrderStatus;
  codeUrl: string | null;
  timeExpireAt: string | null;
  thirdTradeNo: string | null;
  paidAt: string | null;
  refundStatus: string | null;
  refundedAt: string | null;
  createdAt: string;
  updatedAt: string;
  gatewayStatus?: string;
};

function toChineseOrderStatus(status: OrderStatus) {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'pending') return '待支付';
  if (normalized === 'paid' || normalized === 'credited') return '已支付';
  if (normalized === 'closed') return '已关闭';
  if (normalized === 'failed') return '支付失败';
  if (normalized === 'refund_pending') return '退款中';
  if (normalized === 'refunded') return '已退款';
  return status;
}

function pad2(value: number) {
  return String(value).padStart(2, '0');
}

function formatRemaining(seconds: number) {
  const safe = Math.max(0, seconds);
  const mm = pad2(Math.floor(safe / 60));
  const ss = pad2(safe % 60);
  return `${mm}:${ss}`;
}

const ORDER_EXPIRE_MS = 15 * 60 * 1000;
const PAY_ORDER_SYNC_EVENT = 'kunkun-pay-order-updated';
const PAY_ORDER_SYNC_STORAGE_KEY = 'kunkun-pay-order-sync-v1';

export default function PayOrderPage() {
  const params = useParams<{ orderNo: string }>();
  const router = useRouter();
  const orderNo = String(params?.orderNo || '');

  const [order, setOrder] = useState<PayOrder | null>(null);
  const [loading, setLoading] = useState(true);
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);
  const [closingExpired, setClosingExpired] = useState(false);
  const [pollingBlocked, setPollingBlocked] = useState(false);
  const [orderAccessDenied, setOrderAccessDenied] = useState(false);
  const notifiedStatusRef = useRef('');

  const amountYuan = useMemo(() => ((order?.amountFen || 0) / 100).toFixed(2), [order?.amountFen]);
  const loginHref = useMemo(
    () => `/?login=1&expired=1&returnTo=${encodeURIComponent(`/pay/${orderNo}`)}`,
    [orderNo]
  );
  const paidOrCredited = order?.status === 'paid' || order?.status === 'credited';
  const isPending = order?.status === 'pending';

  const fetchOrder = useCallback(async () => {
    if (!orderNo) return;
    setPollingBlocked(false);
    setOrderAccessDenied(false);
    const response = await fetch(`/api/pay/orders/${orderNo}`, { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data?.success || !data?.data) {
      if (response.status === 401 || response.status === 403) {
        setPollingBlocked(true);
        setOrderAccessDenied(true);
        setOrder(null);
      }
      throw new Error(data?.message || '订单获取失败');
    }
    setOrder(data.data as PayOrder);
  }, [orderNo]);

  const queryOrderStatus = useCallback(async () => {
    if (!orderNo) return;
    const response = await fetch(`/api/pay/orders/${orderNo}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401 || response.status === 403) {
      setPollingBlocked(true);
      setOrderAccessDenied(true);
      setOrder(null);
      return;
    }
    if (!response.ok || !data?.success || !data?.data) return;
    setOrder((prev) => (prev ? { ...prev, ...(data.data as PayOrder) } : prev));
  }, [orderNo]);

  const notifyOrderUpdated = useCallback((nextOrder: PayOrder) => {
    if (typeof window === 'undefined') return;

    const payload = {
      type: PAY_ORDER_SYNC_EVENT,
      orderNo: nextOrder.orderNo,
      status: nextOrder.status,
      points: nextOrder.points,
      amountFen: nextOrder.amountFen,
      updatedAt: Date.now(),
    };

    try {
      window.opener?.postMessage(payload, window.location.origin);
    } catch {
      // ignore cross-window notification failure
    }

    try {
      const channel = new BroadcastChannel(PAY_ORDER_SYNC_EVENT);
      channel.postMessage(payload);
      channel.close();
    } catch {
      // ignore unsupported BroadcastChannel
    }

    try {
      window.localStorage.setItem(PAY_ORDER_SYNC_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // ignore storage notification failure
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await fetchOrder();
      } catch (error: unknown) {
        if (!cancelled) toast.error(error instanceof Error ? error.message : '订单获取失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [fetchOrder]);

  useEffect(() => {
    if (!orderNo || !order || !isPending || pollingBlocked) return;

    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void queryOrderStatus();
    }, 3000);

    return () => {
      window.clearInterval(timer);
    };
  }, [isPending, order, orderNo, pollingBlocked, queryOrderStatus]);

  useEffect(() => {
    if (!paidOrCredited || !order) return;
    const notifyKey = `${order.orderNo}:${order.status}`;
    if (notifiedStatusRef.current === notifyKey) return;
    notifiedStatusRef.current = notifyKey;
    notifyOrderUpdated(order);
    void refreshUserBalance();
  }, [order, paidOrCredited, notifyOrderUpdated]);

  useEffect(() => {
    if (!order) return;
    if (!isPending) return;

    const expireMs = order.timeExpireAt ? new Date(order.timeExpireAt).getTime() : new Date(order.createdAt).getTime() + ORDER_EXPIRE_MS;
    if (Number.isNaN(expireMs)) return;

    const computeRemain = () => Math.floor((expireMs - Date.now()) / 1000);
    setRemainingSeconds(Math.max(0, computeRemain()));

    const timer = window.setInterval(() => {
      setRemainingSeconds(Math.max(0, computeRemain()));
    }, 1000);

    return () => window.clearInterval(timer);
  }, [order, isPending]);

  useEffect(() => {
    if (!order?.channel || order.channel !== 'wechat') {
      setQrDataUrl('');
      return;
    }
    if (!order.codeUrl) {
      setQrDataUrl('');
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const dataUrl = await QRCode.toDataURL(order.codeUrl as string, {
          errorCorrectionLevel: 'M',
          margin: 1,
          width: 320,
        });
        if (!cancelled) setQrDataUrl(dataUrl);
      } catch {
        if (!cancelled) setQrDataUrl('');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [order?.codeUrl, order?.channel]);

  useEffect(() => {
    if (!isPending) return;
    if (remainingSeconds === null) return;
    if (remainingSeconds > 0) return;
    if (closingExpired) return;

    setClosingExpired(true);
    void (async () => {
      try {
        await fetch(`/api/pay/orders/${orderNo}/close`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: 'expired_timeout' }),
        });
      } catch {
        // ignore
      } finally {
        await queryOrderStatus();
        setClosingExpired(false);
      }
    })();
  }, [isPending, remainingSeconds, closingExpired, orderNo, queryOrderStatus]);

  const handleMockPaid = async () => {
    try {
      const response = await fetch('/api/pay/mock/mark-paid', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderNo }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.success) {
        toast.error(data?.message || '模拟支付失败');
        return;
      }
      toast.success('模拟支付成功');
      await queryOrderStatus();
      await refreshUserBalance();
    } catch {
      toast.error('模拟支付失败');
    }
  };

  const remainingText = remainingSeconds === null ? '--:--' : formatRemaining(remainingSeconds);

  return (
    <div className="min-h-screen bg-[#f4f6fb] p-4 sm:p-8">
      <Toaster position="top-center" richColors />
      <div className="max-w-2xl mx-auto">
        <div className="mb-4">
          <Link href="/" className="text-sm text-zinc-600 hover:text-zinc-800">返回首页</Link>
        </div>

        <div className="bg-white border border-zinc-200 rounded-2xl p-6 sm:p-8">
          <h1 className="text-2xl font-bold text-zinc-900 mb-2">扫码支付</h1>
          <p className="text-sm text-zinc-500 mb-6">订单号：{orderNo}</p>

          {loading ? (
            <div className="text-zinc-500 text-sm">订单加载中...</div>
          ) : orderAccessDenied ? (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              <div className="font-medium">请重新登录后查看订单</div>
              <div className="mt-1 text-amber-700">当前登录状态已失效，登录后会回到此订单页面。</div>
              <div className="mt-4 flex flex-wrap gap-2">
                <Link href={loginHref} className="h-10 px-4 rounded-xl btn-brand-gradient inline-flex items-center justify-center">
                  返回登录
                </Link>
                <Link href="/" className="h-10 px-4 rounded-xl border border-amber-200 bg-white text-amber-800 inline-flex items-center justify-center hover:bg-amber-100">
                  回到首页
                </Link>
              </div>
            </div>
          ) : !order ? (
            <div className="text-rose-600 text-sm">订单不存在或无权限访问</div>
          ) : (
            <>
              <div className="rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-zinc-700 mb-5 space-y-1">
                <div>充值金额：￥{amountYuan}</div>
                <div>到账积分：{order.points}</div>
                <div>订单状态：{toChineseOrderStatus(order.status)}</div>
                {order.gatewayStatus ? <div>渠道状态：{order.gatewayStatus}</div> : null}
                {isPending ? <div>剩余支付时间：{remainingText}</div> : null}
                {order.refundStatus ? <div>退款状态：{order.refundStatus}</div> : null}
              </div>

              {order.channel === 'wechat' ? (
                <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-4 text-center">
                  <div className="text-sm text-zinc-600 mb-2">请使用微信扫一扫完成支付</div>
                  {qrDataUrl ? (
                    /* eslint-disable-next-line @next/next/no-img-element -- 支付二维码为运行时 data URL，保持浏览器原生渲染 */
                    <img
                      src={qrDataUrl}
                      alt="微信支付二维码"
                      className="w-56 h-56 mx-auto rounded-xl border border-zinc-200 bg-white object-contain"
                    />
                  ) : (
                    <div className="w-56 h-56 mx-auto rounded-xl border border-zinc-200 bg-white flex items-center justify-center text-sm text-zinc-400">
                      二维码生成中...
                    </div>
                  )}
                  <div className="mt-3 text-xs text-zinc-500 break-all">
                    {order.codeUrl || '支付链接生成中'}
                  </div>
                  <div className="mt-2 text-xs text-zinc-500">特殊商品不支持自助退款</div>
                </div>
              ) : (
                <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-4 text-center space-y-3">
                  <div className="text-sm text-zinc-600">当前订单不是微信 Native 支付订单</div>
                  <div className="text-xs text-zinc-500">如需继续保留支付宝收款，请沿用原有流程。</div>
                </div>
              )}

              <div className="mt-5 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void queryOrderStatus()}
                  className="h-10 px-4 rounded-xl border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50"
                >
                  刷新支付状态
                </button>

                {process.env.NODE_ENV !== 'production' && !paidOrCredited ? (
                  <button
                    type="button"
                    onClick={() => void handleMockPaid()}
                    className="h-10 px-4 rounded-xl bg-gradient-to-r from-[#dde9ff] to-[#f9efff] text-[#266eff] font-medium"
                  >
                    开发调试：模拟支付成功
                  </button>
                ) : null}

                {paidOrCredited ? (
                  <button
                    type="button"
                    onClick={() => router.push('/')}
                    className="h-10 px-4 rounded-xl btn-brand-gradient"
                  >
                    返回首页
                  </button>
                ) : null}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
