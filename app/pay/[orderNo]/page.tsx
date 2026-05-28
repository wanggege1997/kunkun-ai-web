'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Toaster, toast } from 'sonner';
import { refreshUserBalance } from '@/lib/user-balance-store';

type OrderStatus = 'pending' | 'paid' | 'credited' | 'closed' | 'failed' | string;
type PayChannel = 'wechat' | 'alipay';

type PayOrder = {
  orderNo: string;
  channel: PayChannel;
  amountFen: number;
  points: number;
  status: OrderStatus;
  createdAt: string;
  updatedAt: string;
};

function toChineseOrderStatus(status: OrderStatus) {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'pending') return '待支付';
  if (normalized === 'paid' || normalized === 'credited') return '已支付';
  if (normalized === 'closed') return '已关闭';
  if (normalized === 'failed') return '支付失败';
  return status;
}

const ORDER_EXPIRE_MS = 15 * 60 * 1000;

export default function PayOrderPage() {
  const params = useParams<{ orderNo: string }>();
  const router = useRouter();
  const orderNo = String(params?.orderNo || '');

  const [order, setOrder] = useState<PayOrder | null>(null);
  const [activeChannel, setActiveChannel] = useState<PayChannel>('wechat');
  const [wechatQrDataUrl, setWechatQrDataUrl] = useState('');
  const [alipayQrDataUrl, setAlipayQrDataUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);
  const [closingExpired, setClosingExpired] = useState(false);

  const amountYuan = useMemo(() => ((order?.amountFen || 0) / 100).toFixed(2), [order?.amountFen]);
  const paidOrCredited = order?.status === 'paid' || order?.status === 'credited';
  const isPending = order?.status === 'pending';

  const remainingText = useMemo(() => {
    const seconds = Math.max(0, remainingSeconds ?? 0);
    const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
    const ss = String(seconds % 60).padStart(2, '0');
    return `${mm}:${ss}`;
  }, [remainingSeconds]);

  const fetchOrder = async () => {
    if (!orderNo) return;
    const response = await fetch(`/api/pay/orders/${orderNo}`, { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data?.success || !data?.data) {
      throw new Error(data?.message || '订单获取失败');
    }
    const next = data.data as PayOrder;
    setOrder(next);
    setActiveChannel(next.channel || 'wechat');
  };

  const queryOrderStatus = async () => {
    if (!orderNo) return;
    const response = await fetch(`/api/pay/orders/${orderNo}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data?.success || !data?.data) return;
    setOrder((prev) => (prev ? { ...prev, status: String(data.data.status || prev.status) } : prev));
  };

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    void (async () => {
      try {
        await fetchOrder();
      } catch (error: unknown) {
        if (!cancelled) toast.error(error instanceof Error ? error.message : '订单获取失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void queryOrderStatus();
    }, 3000);

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [orderNo]);

  useEffect(() => {
    if (!paidOrCredited) return;
    void refreshUserBalance();
  }, [paidOrCredited]);

  useEffect(() => {
    if (!order?.createdAt) return;
    if (!isPending) return;

    const computeRemain = () => {
      const createdAtMs = new Date(order.createdAt).getTime();
      if (Number.isNaN(createdAtMs)) return 0;
      const expireAt = createdAtMs + ORDER_EXPIRE_MS;
      return Math.floor((expireAt - Date.now()) / 1000);
    };

    setRemainingSeconds(Math.max(0, computeRemain()));

    const timer = setInterval(() => {
      const next = computeRemain();
      setRemainingSeconds(Math.max(0, next));
    }, 1000);

    return () => clearInterval(timer);
  }, [order?.createdAt, isPending]);

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
  }, [isPending, remainingSeconds, closingExpired, orderNo]);

  const handleQrUpload = (channel: PayChannel, event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      if (channel === 'wechat') setWechatQrDataUrl(dataUrl);
      else setAlipayQrDataUrl(dataUrl);
    };
    reader.readAsDataURL(file);
    event.target.value = '';
  };

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
          ) : !order ? (
            <div className="text-rose-600 text-sm">订单不存在或无权限访问</div>
          ) : (
            <>
              <div className="rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-zinc-700 mb-5 space-y-1">
                <div>充值金额：￥{amountYuan}</div>
                <div>到账积分：{order.points}</div>
                <div>订单状态：{toChineseOrderStatus(order.status)}</div>
                {isPending ? <div>剩余支付时间：{remainingText}</div> : null}
              </div>

              <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-4 text-center">
                <div className="text-sm text-zinc-600 mb-2">请使用{activeChannel === 'wechat' ? '微信' : '支付宝'}扫码支付</div>
                <img
                  src={activeChannel === 'wechat' ? (wechatQrDataUrl || 'https://dummyimage.com/240x240/f3f4f6/999.png&text=WeChat+QR') : (alipayQrDataUrl || 'https://dummyimage.com/240x240/f3f4f6/999.png&text=Alipay+QR')}
                  alt={activeChannel === 'wechat' ? '微信收款码' : '支付宝收款码'}
                  className="w-56 h-56 mx-auto rounded-xl border border-zinc-200 bg-white object-cover"
                />
                <label className="inline-block mt-3 text-sm text-[#266eff] cursor-pointer hover:brightness-95">
                  上传{activeChannel === 'wechat' ? '微信' : '支付宝'}收款二维码（预留）
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="hidden"
                    onChange={(e) => handleQrUpload(activeChannel, e)}
                  />
                </label>
              </div>

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
