import { NextResponse } from 'next/server';
import { getSessionUserFromRequest } from '@/lib/server-auth';
import { saveTempFileToOss } from '@/lib/temp-file-storage';
import { parseBuffer } from 'music-metadata';

export const runtime = 'nodejs';

const MAX_UPLOAD_SIZE_MB = Number(process.env.TEMP_UPLOAD_MAX_MB || 30);
const MAX_UPLOAD_SIZE_BYTES = Math.max(1, MAX_UPLOAD_SIZE_MB) * 1024 * 1024;

async function enforceAudioDurationPolicy(params: {
  workflowId: string;
  inputKey: string;
  contentType: string;
  fileBuffer: Buffer;
}) {
  const { workflowId, inputKey, contentType, fileBuffer } = params;
  if (workflowId !== '2037571485572800513') return;
  if (!contentType.startsWith('audio/')) return;

  const metadata = await parseBuffer(fileBuffer, { mimeType: contentType });
  const duration = Number(metadata.format.duration || 0);
  const maxSec = inputKey === 'audio_ref' ? 30 : 120;
  if (Number.isFinite(duration) && duration > maxSec) {
    throw new Error(`${inputKey === 'audio_ref' ? '目标音色音频' : '源音频'}时长超限（当前 ${Math.ceil(duration)}s，最大 ${maxSec}s）`);
  }
}

export async function POST(request: Request) {
  const sessionUser = await getSessionUserFromRequest(request);
  if (!sessionUser) {
    return NextResponse.json({ success: false, message: '未登录' }, { status: 401 });
  }

  try {
    const formData = await request.formData();
    const file = formData.get('file');
    const workflowId = String(formData.get('workflowId') || '').trim();
    const inputKey = String(formData.get('inputKey') || '').trim();
    if (!(file instanceof File)) {
      return NextResponse.json({ success: false, message: '缺少上传文件' }, { status: 400 });
    }

    if (file.size <= 0) {
      return NextResponse.json({ success: false, message: '文件不能为空' }, { status: 400 });
    }

    if (file.size > MAX_UPLOAD_SIZE_BYTES) {
      return NextResponse.json(
        { success: false, message: `文件过大，单文件最大 ${MAX_UPLOAD_SIZE_MB}MB` },
        { status: 413 }
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const fileBuffer = Buffer.from(arrayBuffer);
    await enforceAudioDurationPolicy({
      workflowId,
      inputKey,
      contentType: file.type || 'application/octet-stream',
      fileBuffer,
    });

    const stored = await saveTempFileToOss({
      fileBuffer,
      fileName: file.name || 'upload.bin',
      contentType: file.type || 'application/octet-stream',
    });

    return NextResponse.json({
      success: true,
      data: {
        fileKey: stored.fileKey,
        fileName: stored.fileName,
        contentType: stored.contentType,
        size: stored.size,
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : '上传失败';
    return NextResponse.json({ success: false, message }, { status: 500 });
  }
}
