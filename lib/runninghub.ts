import { Buffer } from 'buffer';
import { pushSecurityAudit } from '@/lib/risk-control';

type CachedNodeInfo = {
  expiresAt: number;
  nodeInfoList: Array<Record<string, unknown>>;
};

const DEMO_CACHE_TTL_MS = 2 * 60 * 1000;

const globalForRunningHub = globalThis as unknown as {
  runningHubDemoCache?: Map<string, CachedNodeInfo>;
};

function getDemoCache() {
  if (!globalForRunningHub.runningHubDemoCache) {
    globalForRunningHub.runningHubDemoCache = new Map<string, CachedNodeInfo>();
  }
  return globalForRunningHub.runningHubDemoCache;
}

function parseDataUrl(dataUrl: string) {
  const m = dataUrl.match(/^data:(.*?);base64,(.*)$/);
  if (!m) return null;
  return { mime: m[1], base64: m[2] };
}

export async function readJsonSafe(res: Response) {
  const text = await res.text();
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: null as unknown };
  }
}

export function sanitizeRunningHubLog(payload: unknown): unknown {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload || {});
  const masked = text
    .replace(/("apiKey"\s*:\s*")([^"]+)(")/gi, '$1***$3')
    .replace(/([?&]apiKey=)([^&]+)/gi, '$1***')
    .replace(/("dataUrl"\s*:\s*")data:[^"]+(")/gi, '$1data:***$2');
  try {
    return JSON.parse(masked);
  } catch {
    return masked;
  }
}

export function getRunningHubApiKey() {
  return process.env.RUNNINGHUB_API_KEY?.trim() || '';
}

export async function uploadFileToRunningHub(apiKey: string, input: { fileName: string; dataUrl: string }) {
  const parsed = parseDataUrl(input.dataUrl);
  if (!parsed) throw new Error('文件 dataUrl 格式不正确');

  const buffer = Buffer.from(parsed.base64, 'base64');
  const blob = new Blob([buffer], { type: parsed.mime || 'application/octet-stream' });

  const form = new FormData();
  form.append('apiKey', apiKey);
  form.append('fileType', 'input');
  form.append('file', blob, input.fileName || 'upload.bin');

  const uploadRes = await fetch('https://www.runninghub.cn/task/openapi/upload', {
    method: 'POST',
    body: form,
    cache: 'no-store',
  });

  const uploadData = await readJsonSafe(uploadRes);
  if (!uploadData.json || uploadData.json.code !== 0 || !uploadData.json?.data?.fileName) {
    throw new Error(uploadData.json?.msg || `上传失败：${uploadData.text.slice(0, 200)}`);
  }

  return String(uploadData.json.data.fileName || '');
}

export async function uploadFileBufferToRunningHub(apiKey: string, input: { fileName: string; contentType?: string; buffer: Buffer }) {
  const arrayBuffer = input.buffer.buffer.slice(
    input.buffer.byteOffset,
    input.buffer.byteOffset + input.buffer.byteLength
  ) as ArrayBuffer;
  const blob = new Blob([arrayBuffer], { type: input.contentType || 'application/octet-stream' });

  const form = new FormData();
  form.append('apiKey', apiKey);
  form.append('fileType', 'input');
  form.append('file', blob, input.fileName || 'upload.bin');

  const uploadRes = await fetch('https://www.runninghub.cn/task/openapi/upload', {
    method: 'POST',
    body: form,
    cache: 'no-store',
  });

  const uploadData = await readJsonSafe(uploadRes);
  if (!uploadData.json || uploadData.json.code !== 0 || !uploadData.json?.data?.fileName) {
    throw new Error(uploadData.json?.msg || `上传失败：${uploadData.text.slice(0, 200)}`);
  }

  return String(uploadData.json.data.fileName || '');
}

export async function getApiCallDemoNodeInfoList(
  apiKey: string,
  webappId: string,
  options?: { forceRefresh?: boolean }
) {
  const cache = getDemoCache();
  const key = `${webappId}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (!options?.forceRefresh && hit && hit.expiresAt > now && Array.isArray(hit.nodeInfoList) && hit.nodeInfoList.length > 0) {
    return { nodeInfoList: hit.nodeInfoList, cached: true as const };
  }

  const demoUrl =
    `https://www.runninghub.cn/api/webapp/apiCallDemo` +
    `?apiKey=${encodeURIComponent(apiKey)}&webappId=${encodeURIComponent(webappId)}`;
  const demoRes = await fetch(demoUrl, { method: 'GET', cache: 'no-store' });
  const demoData = await readJsonSafe(demoRes);
  if (!demoData.json || demoData.json.code !== 0) {
    const message = String(demoData.json?.msg || '获取 nodeInfoList 失败');
    throw new Error(message);
  }
  const nodeInfoList = (demoData.json?.data?.nodeInfoList || []) as Array<Record<string, unknown>>;
  if (!Array.isArray(nodeInfoList) || nodeInfoList.length === 0) {
    throw new Error('nodeInfoList 为空，请确认 webappId 是否正确');
  }

  cache.set(key, {
    expiresAt: now + DEMO_CACHE_TTL_MS,
    nodeInfoList,
  });
  return { nodeInfoList, cached: false as const };
}

export async function runAiApp(apiKey: string, webappId: string, nodeInfoList: unknown[]) {
  const runRes = await fetch('https://www.runninghub.cn/task/openapi/ai-app/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ webappId, apiKey, nodeInfoList }),
    cache: 'no-store',
  });
  const runData = await readJsonSafe(runRes);
  return { runRes, runData };
}

export async function queryTaskOutputs(apiKey: string, taskId: string) {
  const res = await fetch('https://www.runninghub.cn/task/openapi/outputs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ apiKey, taskId }),
    cache: 'no-store',
  });
  const parsed = await readJsonSafe(res);
  return { res, parsed };
}

export async function cancelRunningHubTask(apiKey: string, taskId: string) {
  if (!apiKey || !taskId) return;
  await fetch('https://www.runninghub.cn/task/openapi/cancel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ apiKey, taskId }),
    cache: 'no-store',
  });
}

export async function reportUnknownRunningHubStatus(params: {
  path: string;
  taskId?: string;
  code?: number;
  message?: string;
}) {
  const { path, taskId, code, message } = params;
  const statusCode = Number.isFinite(Number(code)) ? Math.floor(Number(code)) : 520;
  await pushSecurityAudit({
    path,
    action: 'runninghub_unknown_status',
    result: 'failed',
    status: statusCode,
    requestId: taskId,
  }).catch(() => undefined);
  console.warn('[RUNNINGHUB_UNKNOWN_STATUS]', {
    path,
    taskId: taskId || 'N/A',
    code: Number.isFinite(Number(code)) ? code : 'N/A',
    message: String(message || ''),
  });
}
