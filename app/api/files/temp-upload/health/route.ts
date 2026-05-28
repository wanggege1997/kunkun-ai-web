import { NextResponse } from 'next/server';
import { getSessionUserFromRequest } from '@/lib/server-auth';
import {
  deleteTempFileFromOss,
  getTempFileBufferFromOss,
  saveTempFileToOss,
} from '@/lib/temp-file-storage';

export const runtime = 'nodejs';

function masked(value: string) {
  if (!value) return '';
  if (value.length <= 6) return '***';
  return `${value.slice(0, 3)}***${value.slice(-3)}`;
}

export async function GET(request: Request) {
  const sessionUser = await getSessionUserFromRequest(request);
  if (!sessionUser) {
    return NextResponse.json({ success: false, message: '未登录' }, { status: 401 });
  }

  const config = {
    bucket: String(process.env.OSS_BUCKET || '').trim(),
    region: String(process.env.OSS_REGION || '').trim(),
    endpoint: String(process.env.OSS_ENDPOINT || '').trim(),
    accessKeyIdMasked: masked(String(process.env.OSS_ACCESS_KEY_ID || '').trim()),
    tempPrefix: String(process.env.OSS_TEMP_PREFIX || 'tmp-inputs/').trim(),
  };

  const missing: string[] = [];
  if (!config.bucket) missing.push('OSS_BUCKET');
  if (!config.region) missing.push('OSS_REGION');
  if (!String(process.env.OSS_ACCESS_KEY_ID || '').trim()) missing.push('OSS_ACCESS_KEY_ID');
  if (!String(process.env.OSS_ACCESS_KEY_SECRET || '').trim()) missing.push('OSS_ACCESS_KEY_SECRET');

  if (missing.length > 0) {
    return NextResponse.json(
      {
        success: false,
        stage: 'config',
        message: `缺少配置：${missing.join(', ')}`,
        config,
      },
      { status: 400 }
    );
  }

  let fileKey = '';
  try {
    const probe = Buffer.from(`health-check-${Date.now()}`);
    const saved = await saveTempFileToOss({
      fileBuffer: probe,
      fileName: 'health-check.txt',
      contentType: 'text/plain',
    });
    fileKey = saved.fileKey;

    const loaded = await getTempFileBufferFromOss(fileKey);
    const content = loaded.buffer.toString('utf8');
    if (!content.startsWith('health-check-')) {
      throw new Error('读取回包校验失败');
    }

    await deleteTempFileFromOss(fileKey);
    fileKey = '';

    return NextResponse.json({
      success: true,
      stage: 'done',
      message: 'OSS 临时存储链路正常（写入/读取/删除通过）',
      config,
    });
  } catch (error: unknown) {
    if (fileKey) {
      await deleteTempFileFromOss(fileKey).catch(() => undefined);
    }
    const message = error instanceof Error ? error.message : 'unknown error';
    return NextResponse.json(
      {
        success: false,
        stage: 'io',
        message,
        config,
      },
      { status: 500 }
    );
  }
}
