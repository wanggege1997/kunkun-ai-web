import crypto from 'crypto';
import fs from 'fs';

export type WechatPayConfig = {
  mchId: string;
  appId: string;
  apiV3Key: string;
  merchantSerialNo: string;
  merchantPrivateKeyPem: string;
  wechatPayPublicKeyId: string;
  wechatPayPublicKeyPem: string;
  platformCertSerialNo: string;
  platformCertPem: string;
  notifyUrl: string;
  refundNotifyUrl: string;
  apiBaseUrl: string;
};

type WechatNativeOrderInput = {
  orderNo: string;
  amountFen: number;
  description: string;
  timeExpireAt: Date;
  notifyUrl?: string;
};

type WechatRefundInput = {
  orderNo: string;
  refundNo: string;
  amountFen: number;
  reason?: string;
  transactionId?: string | null;
  notifyUrl?: string;
};

type WechatApiErrorBody = {
  code?: string;
  message?: string;
  detail?: unknown;
};

type WechatPayResponse<T> = {
  status: number;
  headers: Headers;
  data: T;
  rawText: string;
};

type WechatNotificationHeaders = {
  timestamp: string;
  nonce: string;
  signature: string;
  serial: string;
};

type WechatNotificationResource = {
  algorithm: string;
  ciphertext: string;
  associated_data?: string;
  nonce: string;
};

function normalizePem(value: string) {
  return value.replace(/\\n/g, '\n').trim();
}

function readMaybeFile(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.includes('BEGIN ')) return normalizePem(trimmed);
  if (fs.existsSync(trimmed)) {
    return normalizePem(fs.readFileSync(trimmed, 'utf8'));
  }
  return normalizePem(trimmed);
}

export function getWechatPayConfig(): WechatPayConfig | null {
  const mchId = String(process.env.WECHAT_MCH_ID || '').trim();
  const appId = String(process.env.WECHAT_APP_ID || process.env.WECHAT_MP_APP_ID || '').trim();
  const apiV3Key = String(process.env.WECHAT_API_V3_KEY || '').trim();
  const merchantSerialNo = String(process.env.WECHAT_API_CERT_SERIAL_NO || '').trim();
  const wechatPayPublicKeyId = String(process.env.WECHAT_PAY_PUBLIC_KEY_ID || process.env.WECHAT_PUBLIC_KEY_ID || '').trim();
  const platformCertSerialNo = String(process.env.WECHAT_PLATFORM_CERT_SERIAL_NO || '').trim();
  const apiBaseUrl = String(process.env.WECHAT_API_BASE_URL || 'https://api.mch.weixin.qq.com').trim();

  const privateKeyValue =
    String(process.env.WECHAT_API_PRIVATE_KEY_PEM || '').trim() ||
    String(process.env.WECHAT_API_PRIVATE_KEY || '').trim() ||
    String(process.env.WECHAT_API_PRIVATE_KEY_PATH || '').trim();
  const wechatPayPublicKeyValue =
    String(process.env.WECHAT_PAY_PUBLIC_KEY_PEM || '').trim() ||
    String(process.env.WECHAT_PAY_PUBLIC_KEY || '').trim() ||
    String(process.env.WECHAT_PAY_PUBLIC_KEY_PATH || '').trim() ||
    String(process.env.WECHAT_PUBLIC_KEY_PATH || '').trim();
  const platformCertValue =
    String(process.env.WECHAT_PLATFORM_CERT_PEM || '').trim() ||
    String(process.env.WECHAT_PLATFORM_CERT || '').trim() ||
    String(process.env.WECHAT_PLATFORM_CERT_PATH || '').trim();

  const hasPublicKeyVerifier = Boolean(wechatPayPublicKeyId && wechatPayPublicKeyValue);
  const hasPlatformCertVerifier = Boolean(platformCertSerialNo && platformCertValue);

  if (!mchId || !appId || !apiV3Key || !merchantSerialNo || !privateKeyValue || (!hasPublicKeyVerifier && !hasPlatformCertVerifier)) {
    return null;
  }

  const merchantPrivateKeyPem = readMaybeFile(privateKeyValue);
  const wechatPayPublicKeyPem = wechatPayPublicKeyValue ? readMaybeFile(wechatPayPublicKeyValue) : '';
  const platformCertPem = platformCertValue ? readMaybeFile(platformCertValue) : '';

  if (!merchantPrivateKeyPem) return null;
  if (hasPublicKeyVerifier && !wechatPayPublicKeyPem) return null;
  if (!hasPublicKeyVerifier && hasPlatformCertVerifier && !platformCertPem) return null;

  const notifyUrl = String(process.env.WECHAT_NOTIFY_URL || '').trim() || '';
  const refundNotifyUrl = String(process.env.WECHAT_REFUND_NOTIFY_URL || '').trim() || '';

  return {
    mchId,
    appId,
    apiV3Key,
    merchantSerialNo,
    merchantPrivateKeyPem,
    wechatPayPublicKeyId,
    wechatPayPublicKeyPem,
    platformCertSerialNo,
    platformCertPem,
    notifyUrl,
    refundNotifyUrl,
    apiBaseUrl,
  };
}

export function isWechatPayConfigured() {
  return Boolean(getWechatPayConfig());
}

function formatWechatTimeExpire(date: Date) {
  const offsetMs = 8 * 60 * 60 * 1000;
  const shifted = new Date(date.getTime() + offsetMs);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  const hour = String(shifted.getUTCHours()).padStart(2, '0');
  const minute = String(shifted.getUTCMinutes()).padStart(2, '0');
  const second = String(shifted.getUTCSeconds()).padStart(2, '0');
  return `${year}-${month}-${day}T${hour}:${minute}:${second}+08:00`;
}

function buildRequestPath(pathname: string, query?: string) {
  return query ? `${pathname}?${query}` : pathname;
}

function buildAuthMessage(method: string, uri: string, timestamp: string, nonce: string, body: string) {
  return `${method.toUpperCase()}\n${uri}\n${timestamp}\n${nonce}\n${body}\n`;
}

function createAuthorizationHeader(config: WechatPayConfig, method: string, uri: string, body: string) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const message = buildAuthMessage(method, uri, timestamp, nonce, body);
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(message);
  signer.end();
  const signature = signer.sign(config.merchantPrivateKeyPem, 'base64');

  return `WECHATPAY2-SHA256-RSA2048 mchid="${config.mchId}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${config.merchantSerialNo}"`;
}

async function requestWechatApi<T>(
  config: WechatPayConfig,
  method: string,
  pathname: string,
  body?: unknown,
  query?: string
): Promise<WechatPayResponse<T>> {
  const bodyText = body === undefined ? '' : JSON.stringify(body);
  const uri = buildRequestPath(pathname, query);
  const response = await fetch(`${config.apiBaseUrl}${uri}`, {
    method,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: createAuthorizationHeader(config, method, uri, bodyText),
    },
    body: bodyText || undefined,
    cache: 'no-store',
  });

  const rawText = await response.text();
  let data: T;
  try {
    data = JSON.parse(rawText) as T;
  } catch {
    data = rawText as T;
  }

  return {
    status: response.status,
    headers: response.headers,
    data,
    rawText,
  };
}

function createErrorMessage(status: number, body: unknown) {
  const payload = body as WechatApiErrorBody | string | undefined;
  if (typeof payload === 'string') return `WeChat API ${status}: ${payload}`;
  const code = payload?.code ? ` ${payload.code}` : '';
  const message = payload?.message ? ` ${payload.message}` : '';
  return `WeChat API${code}${message}`.trim() || `WeChat API ${status}`;
}

export async function createWechatNativeOrder(input: WechatNativeOrderInput) {
  const config = getWechatPayConfig();
  if (!config) {
    throw new Error('微信支付配置不完整');
  }

  const notifyUrl = input.notifyUrl || config.notifyUrl || `${String(process.env.INTERNAL_BASE_URL || '').replace(/\/$/, '')}/api/pay/wechat/notify`;
  const response = await requestWechatApi<{ code_url?: string }>(
    config,
    'POST',
    '/v3/pay/transactions/native',
    {
      appid: config.appId,
      mchid: config.mchId,
      description: input.description.slice(0, 127),
      out_trade_no: input.orderNo,
      time_expire: formatWechatTimeExpire(input.timeExpireAt),
      notify_url: notifyUrl,
      amount: {
        total: input.amountFen,
        currency: 'CNY',
      },
    }
  );

  if (response.status < 200 || response.status >= 300 || !response.data?.code_url) {
    throw new Error(createErrorMessage(response.status, response.data));
  }

  return {
    codeUrl: response.data.code_url,
    raw: response.data,
  };
}

export async function queryWechatOrderByOutTradeNo(outTradeNo: string) {
  const config = getWechatPayConfig();
  if (!config) {
    throw new Error('微信支付配置不完整');
  }

  const response = await requestWechatApi<Record<string, unknown>>(
    config,
    'GET',
    `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}`,
    undefined,
    `mchid=${encodeURIComponent(config.mchId)}`
  );

  if (response.status < 200 || response.status >= 300) {
    throw new Error(createErrorMessage(response.status, response.data));
  }

  return response.data;
}

export async function closeWechatOrder(outTradeNo: string) {
  const config = getWechatPayConfig();
  if (!config) {
    throw new Error('微信支付配置不完整');
  }

  const response = await requestWechatApi<Record<string, unknown>>(
    config,
    'POST',
    `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}/close`,
    {
      mchid: config.mchId,
    }
  );

  if (response.status < 200 || response.status >= 300) {
    throw new Error(createErrorMessage(response.status, response.data));
  }

  return response.data;
}

export async function createWechatRefund(input: WechatRefundInput) {
  const config = getWechatPayConfig();
  if (!config) {
    throw new Error('微信支付配置不完整');
  }

  const notifyUrl = input.notifyUrl || config.refundNotifyUrl || `${String(process.env.INTERNAL_BASE_URL || '').replace(/\/$/, '')}/api/pay/wechat/refund-notify`;
  const response = await requestWechatApi<Record<string, unknown>>(
    config,
    'POST',
    '/v3/refund/domestic/refunds',
    {
      out_trade_no: input.orderNo,
      out_refund_no: input.refundNo,
      reason: input.reason || '用户申请退款',
      notify_url: notifyUrl,
      amount: {
        refund: input.amountFen,
        total: input.amountFen,
        currency: 'CNY',
      },
    }
  );

  if (response.status < 200 || response.status >= 300) {
    throw new Error(createErrorMessage(response.status, response.data));
  }

  return response.data;
}

function getWechatSignatureVerifier(serial: string) {
  const config = getWechatPayConfig();
  if (!config) {
    throw new Error('微信支付配置不完整');
  }

  if (config.wechatPayPublicKeyId && config.wechatPayPublicKeyPem && serial === config.wechatPayPublicKeyId) {
    return crypto.createPublicKey(config.wechatPayPublicKeyPem);
  }

  if (config.platformCertSerialNo && config.platformCertPem && serial === config.platformCertSerialNo) {
    return crypto.createPublicKey(config.platformCertPem);
  }

  return null;
}

export function verifyWechatNotificationSignature(headers: Headers, rawBody: string) {
  const timestamp = headers.get('Wechatpay-Timestamp') || headers.get('wechatpay-timestamp') || '';
  const nonce = headers.get('Wechatpay-Nonce') || headers.get('wechatpay-nonce') || '';
  const signature = headers.get('Wechatpay-Signature') || headers.get('wechatpay-signature') || '';
  const serial = headers.get('Wechatpay-Serial') || headers.get('wechatpay-serial') || '';
  if (!timestamp || !nonce || !signature || !serial) return false;

  const publicKey = getWechatSignatureVerifier(serial);
  if (!publicKey) return false;
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(`${timestamp}\n${nonce}\n${rawBody}\n`);
  verifier.end();
  return verifier.verify(publicKey, signature, 'base64');
}

export function parseWechatNotificationHeaders(headers: Headers): WechatNotificationHeaders | null {
  const timestamp = headers.get('Wechatpay-Timestamp') || headers.get('wechatpay-timestamp') || '';
  const nonce = headers.get('Wechatpay-Nonce') || headers.get('wechatpay-nonce') || '';
  const signature = headers.get('Wechatpay-Signature') || headers.get('wechatpay-signature') || '';
  const serial = headers.get('Wechatpay-Serial') || headers.get('wechatpay-serial') || '';
  if (!timestamp || !nonce || !signature || !serial) return null;
  return { timestamp, nonce, signature, serial };
}

export function decryptWechatNotificationResource(resource: WechatNotificationResource) {
  const config = getWechatPayConfig();
  if (!config) {
    throw new Error('微信支付配置不完整');
  }
  const key = Buffer.from(config.apiV3Key, 'utf8');
  const payload = Buffer.from(resource.ciphertext, 'base64');
  if (payload.length < 16) {
    throw new Error('微信回调密文无效');
  }

  const data = payload.subarray(0, payload.length - 16);
  const authTag = payload.subarray(payload.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(resource.nonce, 'utf8'));
  if (resource.associated_data) {
    decipher.setAAD(Buffer.from(resource.associated_data, 'utf8'));
  }
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  return JSON.parse(decrypted) as Record<string, unknown>;
}

export function formatWechatTradeState(status: string) {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'success' || normalized === 'paid' || normalized === 'credited') return 'SUCCESS';
  if (normalized === 'closed') return 'CLOSED';
  if (normalized === 'refund_pending' || normalized === 'refunded' || normalized === 'refund') return 'REFUND';
  if (normalized === 'failed') return 'PAYERROR';
  return 'NOTPAY';
}

export function buildWechatTimeExpire(date: Date) {
  return formatWechatTimeExpire(date);
}
