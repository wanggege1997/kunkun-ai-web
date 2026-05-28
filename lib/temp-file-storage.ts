import OSS from 'ali-oss';

export type TempStoredFile = {
  fileKey: string;
  fileName: string;
  contentType: string;
  size: number;
};

const TEMP_PREFIX = (process.env.OSS_TEMP_PREFIX || 'tmp-inputs/').replace(/^\/+/, '');

function ensureSlashPrefix(value: string) {
  if (!value) return '/';
  return value.startsWith('/') ? value : `/${value}`;
}

function getOssClient() {
  const region = String(process.env.OSS_REGION || '').trim();
  const bucket = String(process.env.OSS_BUCKET || '').trim();
  const accessKeyId = String(process.env.OSS_ACCESS_KEY_ID || '').trim();
  const accessKeySecret = String(process.env.OSS_ACCESS_KEY_SECRET || '').trim();
  const endpoint = String(process.env.OSS_ENDPOINT || '').trim();

  if (!region || !bucket || !accessKeyId || !accessKeySecret) {
    throw new Error('OSS 配置不完整，请检查 OSS_REGION/OSS_BUCKET/OSS_ACCESS_KEY_ID/OSS_ACCESS_KEY_SECRET');
  }

  const secure = endpoint.startsWith('https://') || endpoint === '';
  return new OSS({
    region,
    bucket,
    accessKeyId,
    accessKeySecret,
    endpoint: endpoint || undefined,
    secure,
    timeout: '60000',
  });
}

function safeExtFromName(name: string) {
  const clean = name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const idx = clean.lastIndexOf('.');
  if (idx <= 0 || idx === clean.length - 1) return '';
  const ext = clean.slice(idx + 1).toLowerCase();
  if (!/^[a-z0-9]{1,10}$/.test(ext)) return '';
  return `.${ext}`;
}

export async function saveTempFileToOss(input: {
  fileBuffer: Buffer;
  fileName: string;
  contentType?: string;
}): Promise<TempStoredFile> {
  const { fileBuffer, fileName, contentType } = input;
  const client = getOssClient();
  const ext = safeExtFromName(fileName);
  const fileKey = `${TEMP_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`;

  await client.put(fileKey, fileBuffer, {
    headers: {
      'Content-Type': contentType || 'application/octet-stream',
      'Cache-Control': 'no-store',
    },
  });

  return {
    fileKey,
    fileName,
    contentType: contentType || 'application/octet-stream',
    size: fileBuffer.length,
  };
}

export async function getTempFileBufferFromOss(fileKey: string): Promise<{ buffer: Buffer; contentType: string }> {
  const client = getOssClient();
  const cleanKey = fileKey.replace(/^\/+/, '');
  const result = await client.get(cleanKey);
  const body = result.content as Buffer;
  const headers = result.res?.headers || {};
  const contentTypeHeader = (headers['content-type'] || headers['Content-Type'] || 'application/octet-stream') as string;

  return {
    buffer: Buffer.isBuffer(body) ? body : Buffer.from(body),
    contentType: String(contentTypeHeader || 'application/octet-stream'),
  };
}

export async function deleteTempFileFromOss(fileKey: string): Promise<void> {
  const client = getOssClient();
  const cleanKey = fileKey.replace(/^\/+/, '');
  try {
    await client.delete(cleanKey);
  } catch {
    // ignore delete failures
  }
}

export function normalizeTempFileKey(fileKey: string) {
  return ensureSlashPrefix(fileKey.replace(/^\/+/, ''));
}
