import crypto from 'crypto';

export type PaymentChannel = 'wechat' | 'alipay';

export function createOrderNo(prefix = 'ORD') {
  const stamp = Date.now();
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `${prefix}${stamp}${rand}`;
}

export function signPayload(payload: Record<string, unknown>, secret: string) {
  const sortedKeys = Object.keys(payload).sort();
  const canonical = sortedKeys
    .map((key) => `${key}=${String(payload[key] ?? '')}`)
    .join('&');
  return crypto.createHmac('sha256', secret).update(canonical).digest('hex');
}

export function verifyPayloadSignature(
  payload: Record<string, unknown>,
  signature: string,
  secret: string
) {
  const expected = signPayload(payload, secret);
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export function getWechatNotifySecret() {
  return process.env.WECHAT_NOTIFY_SECRET || '';
}

export function getAlipayNotifySecret() {
  return process.env.ALIPAY_NOTIFY_SECRET || '';
}
