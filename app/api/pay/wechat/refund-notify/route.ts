import { NextResponse } from 'next/server';
import { finalizeWechatRefund } from '@/lib/payment-service';
import {
  decryptWechatNotificationResource,
  getWechatPayConfig,
  verifyWechatNotificationSignature,
} from '@/lib/wechat-pay';

export async function POST(request: Request) {
  const rawBody = await request.text();
  const config = getWechatPayConfig();
  if (!config) {
    return NextResponse.json({ success: false, message: '微信支付配置未完整' }, { status: 500 });
  }

  if (!verifyWechatNotificationSignature(request.headers, rawBody)) {
    return NextResponse.json({ success: false, message: '签名校验失败' }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ success: false, message: '回调报文格式错误' }, { status: 400 });
  }

  const eventType = String(body.event_type || '').toUpperCase();
  if (!eventType.startsWith('REFUND.')) {
    return NextResponse.json({ success: true, message: '已忽略非退款回调' });
  }

  const resource = body.resource as {
    algorithm?: string;
    ciphertext?: string;
    associated_data?: string;
    nonce?: string;
  } | undefined;
  if (!resource?.ciphertext || !resource?.nonce) {
    return NextResponse.json({ success: false, message: '回调资源缺失' }, { status: 400 });
  }

  let refund: Record<string, unknown>;
  try {
    refund = decryptWechatNotificationResource({
      algorithm: resource.algorithm || 'AEAD_AES_256_GCM',
      ciphertext: resource.ciphertext,
      associated_data: resource.associated_data,
      nonce: resource.nonce,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : '回调解密失败';
    return NextResponse.json({ success: false, message }, { status: 400 });
  }

  const orderNo = String(refund.out_trade_no || '').trim();
  const refundId = String(refund.refund_id || '').trim() || null;
  const refundStatus = String(refund.refund_status || refund.status || '').toUpperCase();
  const successTimeRaw = String(refund.success_time || '').trim();
  const successTime = successTimeRaw ? new Date(successTimeRaw) : null;

  if (!orderNo) {
    return NextResponse.json({ success: false, message: '缺少订单号' }, { status: 400 });
  }

  try {
    await finalizeWechatRefund(
      orderNo,
      refundStatus || eventType.replace('REFUND.', ''),
      refundId,
      successTime && !Number.isNaN(successTime.getTime()) ? successTime : null
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : '退款状态更新失败';
    return NextResponse.json({ success: false, message }, { status: 500 });
  }

  return NextResponse.json({ success: true, message: 'success' });
}

