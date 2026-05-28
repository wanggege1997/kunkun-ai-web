import { NextRequest, NextResponse } from 'next/server';
import {
  getRunningHubApiKey,
  queryTaskOutputs,
  reportUnknownRunningHubStatus,
  sanitizeRunningHubLog,
} from '@/lib/runninghub';

export const runtime = 'nodejs';

function collectOutputUrls(payload: unknown): string[] {
  const urls: string[] = [];

  const walk = (value: unknown) => {
    if (!value) return;

    if (typeof value === 'string') {
      if (/^https?:\/\//i.test(value)) urls.push(value);
      return;
    }

    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }

    if (typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      const directKeys = ['fileUrl', 'url', 'image', 'video', 'audio', 'src', 'downloadUrl'];
      directKeys.forEach((k) => walk(obj[k]));
      Object.values(obj).forEach(walk);
    }
  };

  walk(payload);
  return Array.from(new Set(urls));
}

function isTimeoutLikeFailure(...parts: Array<unknown>) {
  const text = parts
    .map((item) => String(item || ''))
    .join(' ')
    .toLowerCase();
  if (!text) return false;
  return (
    text.includes('timeout') ||
    text.includes('time out') ||
    text.includes('timed out') ||
    text.includes('超时') ||
    text.includes('执行过久')
  );
}

export async function GET(request: NextRequest) {
  const apiKey = getRunningHubApiKey();
  if (!apiKey) {
    return NextResponse.json({ error: '缺少 RUNNINGHUB_API_KEY' }, { status: 500 });
  }

  try {
    const taskId = request.nextUrl.searchParams.get('taskId');
    if (!taskId) {
      return NextResponse.json({ error: '缺少 taskId' }, { status: 400 });
    }

    const { res, parsed } = await queryTaskOutputs(apiKey, taskId);
    const data = parsed.json;

    console.log('[TASK_OPENAPI] taskId:', taskId);
    console.log('[TASK_OPENAPI] status:', res.status);
    console.log('[TASK_OPENAPI] raw:', sanitizeRunningHubLog(parsed.text));

    if (!data) {
      return NextResponse.json(
        { error: '上游返回非 JSON', upstream: parsed.text.slice(0, 500) },
        { status: 502 }
      );
    }

    // RunningHub:
    // code=0   成功(返回结果数组)
    // code=804 运行中
    // code=813 排队中
    // code=805 失败
    if (data.code === 0) {
      const urls = collectOutputUrls(data.data);

      if (urls.length === 0) {
        return NextResponse.json({
          status: 'failed',
          error: '任务已完成，但未解析到输出文件',
          phase: 'failed',
          message: data?.msg || 'OUTPUT_NOT_FOUND',
          raw: data,
        });
      }

      return NextResponse.json({
        status: 'success',
        output: {
          images: urls,
          url: urls[0] || null,
          items: data.data,
        },
        raw: data,
      });
    }

    if (data.code === 805) {
      const failedReason = data?.data?.failedReason;
      const errMsg =
        failedReason?.exception_message ||
        failedReason?.message ||
        data?.msg ||
        '任务失败';

      if (isTimeoutLikeFailure(errMsg, data?.msg, failedReason?.exception_message, failedReason?.message)) {
        return NextResponse.json({
          status: 'timeout',
          error: errMsg,
          phase: 'timeout',
          message: data?.msg || 'APIKEY_TASK_TIMEOUT',
          raw: data,
        });
      }

      return NextResponse.json({
        status: 'failed',
        error: errMsg,
        phase: 'failed',
        message: data?.msg || 'APIKEY_TASK_FAILED',
        raw: data,
      });
    }

    // 804/813：继续轮询；其他未知状态码：告警上报
    if (data.code !== 804 && data.code !== 813) {
      await reportUnknownRunningHubStatus({
        path: '/api/task-status',
        taskId,
        code: Number(data.code),
        message: String(data?.msg || ''),
      });
    }

    const phase = data.code === 813 ? 'queueing' : data.code === 804 ? 'running' : 'running';
    return NextResponse.json({
      status: 'running',
      phase,
      message: data?.msg || '',
      raw: data,
    });
  } catch (error: unknown) {
    console.error('[TASK_OPENAPI] exception:', error);
    const message = error instanceof Error ? error.message : 'unknown error';
    return NextResponse.json(
      { error: `查询任务状态失败: ${message}` },
      { status: 500 }
    );
  }
}
