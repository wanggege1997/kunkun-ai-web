'use client';

export default function CreatingPayPage() {
  return (
    <div className="min-h-screen bg-[#f4f6fb] flex items-center justify-center p-6">
      <div className="bg-white border border-zinc-200 rounded-2xl px-6 py-5 text-center shadow-sm">
        <div className="text-base font-medium text-zinc-900 mb-1">正在创建支付订单...</div>
        <div className="text-sm text-zinc-500">请稍候，页面将自动跳转到扫码支付。</div>
      </div>
    </div>
  );
}
