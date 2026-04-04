import { NextRequest, NextResponse } from 'next/server';
import { Buffer } from 'buffer';
import { getGlobalStopEnabled } from '@/lib/points';
import { getSessionUserFromRequest } from '@/lib/server-auth';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';

type RunRequestDedupRecord = {
  state: 'inflight' | 'submitted';
  taskId?: string;
  createdAt: number;
};

const RUN_DEDUP_TTL_MS = 24 * 60 * 60 * 1000;
const INFLIGHT_WAIT_MS = 12_000;

const globalForRunDedup = globalThis as unknown as {
  runDedupMap?: Map<string, RunRequestDedupRecord>;
};

function getRunDedupMap() {
  if (!globalForRunDedup.runDedupMap) {
    globalForRunDedup.runDedupMap = new Map<string, RunRequestDedupRecord>();
  }
  return globalForRunDedup.runDedupMap;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function purgeExpiredRunDedup(map: Map<string, RunRequestDedupRecord>) {
  const now = Date.now();
  for (const [key, value] of map.entries()) {
    if (now - value.createdAt > RUN_DEDUP_TTL_MS) {
      map.delete(key);
    }
  }
}

type NodeInfo = {
  nodeId: string;
  nodeName?: string;
  fieldName: string;
  fieldValue: unknown;
  fieldType?: string; // IMAGE / AUDIO / VIDEO / STRING / LIST / NUMBER...
};

type RhFilePayload = {
  __rh_file: true;
  fileName: string;
  dataUrl: string; // data:audio/wav;base64,xxxx
};

const FILE_FIELD_TYPES = new Set(['IMAGE', 'AUDIO', 'VIDEO']);
const NUMBER_FIELD_TYPES = new Set(['INT', 'FLOAT', 'NUMBER']);
const STRING_FIELD_TYPES = new Set(['STRING', 'TEXT', 'COMBO', 'LIST']);

// 第二个音频应用“一键调通”重点：给常见字段名做别名映射
const WEBAPP_INPUT_ALIASES: Record<string, Record<string, string[]>> = {
  // 文生图
  '2037569263141134337': {
    text: ['text', 'prompt'],
    value: ['value', 'strength', 'strength_model'],
  },
  // 音色替换
  '2037571485572800513': {
    text: ['text', 'prompt', 'script', 'content'],
    audio: ['audio', 'input_audio', 'reference_audio', 'voice', 'voice_audio', 'source_audio'],
  },
};

function isRhFilePayload(v: unknown): v is RhFilePayload {
  if (!v || typeof v !== 'object') return false;
  const obj = v as Record<string, unknown>;
  return obj.__rh_file === true && typeof obj.dataUrl === 'string';
}

function normalizeFieldName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function getAliases(webappId: string, inputKey: string) {
  const custom = WEBAPP_INPUT_ALIASES[webappId]?.[inputKey] ?? [];
  return Array.from(new Set([inputKey, ...custom]));
}

async function readJsonSafe(res: Response) {
  const text = await res.text();
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: null as unknown };
  }
}

function parseDataUrl(dataUrl: string) {
  const m = dataUrl.match(/^data:(.*?);base64,(.*)$/);
  if (!m) return null;
  return { mime: m[1], base64: m[2] };
}

async function uploadFileToRunningHub(apiKey: string, payload: RhFilePayload) {
  const parsed = parseDataUrl(payload.dataUrl);
  if (!parsed) throw new Error('文件 dataUrl 格式不正确');

  const buffer = Buffer.from(parsed.base64, 'base64');
  const blob = new Blob([buffer], { type: parsed.mime || 'application/octet-stream' });

  const form = new FormData();
  form.append('apiKey', apiKey);
  form.append('fileType', 'input');
  form.append('file', blob, payload.fileName || 'upload.bin');

  const uploadRes = await fetch('https://www.runninghub.cn/task/openapi/upload', {
    method: 'POST',
    body: form,
    cache: 'no-store',
  });

  const uploadData = await readJsonSafe(uploadRes);
  if (!uploadData.json || uploadData.json.code !== 0 || !uploadData.json?.data?.fileName) {
    throw new Error(uploadData.json?.msg || `上传失败：${uploadData.text.slice(0, 200)}`);
  }

  return uploadData.json.data.fileName as string; // e.g. api/xxxx.jpg
}

export async function POST(request: NextRequest) {
  const apiKey = process.env.RUNNINGHUB_API_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json({ error: '缺少 RUNNINGHUB_API_KEY' }, { status: 500 });
  }

  try {
    const workerSecret = request.headers.get('x-internal-worker-secret') || '';
    const internalSecret = process.env.INTERNAL_WORKER_SECRET || process.env.JWT_SECRET || 'dev-worker-secret';

    let sessionUser = await getSessionUserFromRequest(request);
    const body = await request.json();

    if (!sessionUser && workerSecret && workerSecret === internalSecret) {
      const internalUserId = String(body.userId || '').trim();
      if (internalUserId) {
        const internalUser = await prisma.user.findUnique({
          where: { id: internalUserId },
          select: {
            id: true,
            account: true,
            username: true,
            role: true,
            points: true,
            taskBlocked: true,
          },
        });
        if (internalUser) {
          sessionUser = internalUser;
        }
      }
    }

    if (!sessionUser) {
      return NextResponse.json({ error: '请先登录后再提交任务' }, { status: 401 });
    }

    if (sessionUser.taskBlocked) {
      return NextResponse.json({ error: '当前账号已被暂停任务执行，请联系管理员' }, { status: 403 });
    }

    const globalStopped = await getGlobalStopEnabled();
    if (globalStopped) {
      return NextResponse.json({ error: '系统已开启全局紧急停机，请稍后重试' }, { status: 503 });
    }

    // 前端保持 workflowId 字段名，这里按 webappId 使用
    const webappId = String(body.webappId || body.workflowId || '').trim();
    const inputs = (body.inputs || {}) as Record<string, unknown>;
    const requestId = String(body.requestId || '').trim();

    const ownerKey = sessionUser.id;

    const dedupMap = getRunDedupMap();
    purgeExpiredRunDedup(dedupMap);
    const dedupKey = requestId ? `${ownerKey}:${requestId}` : '';

    if (dedupKey) {
      const existing = dedupMap.get(dedupKey);
      if (existing?.state === 'submitted' && existing.taskId) {
        console.log('[RUN_OPENAPI] idempotent hit(submitted):', dedupKey, 'taskId=', existing.taskId);
        return NextResponse.json({
          ok: true,
          duplicate: true,
          requestId,
          task_id: existing.taskId,
          matchedFields: {},
          unmatchedInputKeys: [],
          raw: { duplicate: true },
        });
      }

      if (existing?.state === 'inflight') {
        const start = Date.now();
        while (Date.now() - start < INFLIGHT_WAIT_MS) {
          await sleep(120);
          const latest = dedupMap.get(dedupKey);
          if (latest?.state === 'submitted' && latest.taskId) {
            console.log('[RUN_OPENAPI] idempotent hit(waited):', dedupKey, 'taskId=', latest.taskId);
            return NextResponse.json({
              ok: true,
              duplicate: true,
              requestId,
              task_id: latest.taskId,
              matchedFields: {},
              unmatchedInputKeys: [],
              raw: { duplicate: true },
            });
          }
          if (!latest) break;
        }

        return NextResponse.json(
          { error: '同 requestId 请求正在处理中，请稍后重试', requestId },
          { status: 409 }
        );
      }

      dedupMap.set(dedupKey, { state: 'inflight', createdAt: Date.now() });
    }

    if (!webappId) {
      return NextResponse.json({ error: '缺少 webappId/workflowId' }, { status: 400 });
    }

    // 1) 获取节点可编辑信息
    const demoUrl =
      `https://www.runninghub.cn/api/webapp/apiCallDemo` +
      `?apiKey=${encodeURIComponent(apiKey)}` +
      `&webappId=${encodeURIComponent(webappId)}`;

    const demoRes = await fetch(demoUrl, { method: 'GET', cache: 'no-store' });
    const demoData = await readJsonSafe(demoRes);

    if (!demoData.json || demoData.json.code !== 0) {
      return NextResponse.json(
        {
          error: demoData.json?.msg || '获取 nodeInfoList 失败',
          upstreamStatus: demoRes.status,
          upstream: demoData.json ?? demoData.text.slice(0, 500),
        },
        { status: 400 }
      );
    }

    const nodeInfoList = (demoData.json?.data?.nodeInfoList || []) as NodeInfo[];
    if (!Array.isArray(nodeInfoList) || nodeInfoList.length === 0) {
      return NextResponse.json(
        { error: 'nodeInfoList 为空，请确认 webappId 是否正确' },
        { status: 400 }
      );
    }

    // 2) 用 inputs 按 fieldName 覆盖 fieldValue（文件先上传）
    const updatedNodeInfoList: NodeInfo[] = [];
    for (const node of nodeInfoList) {
      const next = { ...node };
      updatedNodeInfoList.push(next);
    }

    const matchedFields: Record<string, string> = {};
    const unmatchedInputKeys: string[] = [];

    for (const [inputKey, incoming] of Object.entries(inputs)) {
      if (incoming === undefined || incoming === null || incoming === '') {
        continue;
      }

      const aliases = getAliases(webappId, inputKey);
      const aliasSet = new Set(aliases);
      const normalizedAliasSet = new Set(aliases.map(normalizeFieldName));

      let candidates = updatedNodeInfoList.filter((n) => aliasSet.has(n.fieldName));

      if (candidates.length === 0) {
        candidates = updatedNodeInfoList.filter((n) =>
          normalizedAliasSet.has(normalizeFieldName(String(n.fieldName || '')))
        );
      }

      // 智能兜底：音频/图片/视频文件优先匹配文件类型节点
      if (candidates.length === 0 && isRhFilePayload(incoming)) {
        candidates = updatedNodeInfoList.filter((n) =>
          FILE_FIELD_TYPES.has(String(n.fieldType || '').toUpperCase())
        );
      }

      // 数字、文本兜底
      if (candidates.length === 0 && typeof incoming === 'number') {
        candidates = updatedNodeInfoList.filter((n) =>
          NUMBER_FIELD_TYPES.has(String(n.fieldType || '').toUpperCase())
        );
      }

      if (candidates.length === 0 && typeof incoming === 'string') {
        candidates = updatedNodeInfoList.filter((n) =>
          STRING_FIELD_TYPES.has(String(n.fieldType || '').toUpperCase())
        );
      }

      if (candidates.length === 0) {
        unmatchedInputKeys.push(inputKey);
        continue;
      }

      // 对文件输入，优先选 AUDIO/IMAGE/VIDEO 节点
      let target = candidates[0];
      if (isRhFilePayload(incoming)) {
        target =
          candidates.find((n) => FILE_FIELD_TYPES.has(String(n.fieldType || '').toUpperCase())) ||
          candidates[0];
      }

      if (isRhFilePayload(incoming)) {
        const uploaded = await uploadFileToRunningHub(apiKey, incoming);
        target.fieldValue = uploaded;
      } else {
        target.fieldValue = incoming;
      }

      matchedFields[inputKey] = `${target.nodeId}.${target.fieldName}`;
    }

    const availableFields = updatedNodeInfoList.map((n) => ({
      nodeId: n.nodeId,
      fieldName: n.fieldName,
      fieldType: n.fieldType,
    }));

    if (Object.keys(matchedFields).length === 0) {
      return NextResponse.json(
        {
          error: '未匹配到任何可修改字段，请检查 inputs key 与应用参数是否一致',
          unmatchedInputKeys,
          availableFields,
        },
        { status: 400 }
      );
    }

    // 3) 提交任务
    const runRes = await fetch('https://www.runninghub.cn/task/openapi/ai-app/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        webappId,
        apiKey,
        nodeInfoList: updatedNodeInfoList,
      }),
      cache: 'no-store',
    });

    const runData = await readJsonSafe(runRes);

    console.log('[RUN_OPENAPI] webappId:', webappId);
    console.log('[RUN_OPENAPI] requestId:', requestId || 'N/A');
    console.log('[RUN_OPENAPI] inputs keys:', Object.keys(inputs || {}));
    console.log('[RUN_OPENAPI] matched fields:', matchedFields);
    if (unmatchedInputKeys.length > 0) {
      console.log('[RUN_OPENAPI] unmatched input keys:', unmatchedInputKeys);
    }
    console.log('[RUN_OPENAPI] run status:', runRes.status);
    console.log('[RUN_OPENAPI] run raw:', runData.text);

    if (!runData.json || runData.json.code !== 0) {
      if (dedupKey) dedupMap.delete(dedupKey);
      return NextResponse.json(
        {
          error: runData.json?.msg || '提交任务失败',
          upstreamStatus: runRes.status,
          upstream: runData.json ?? runData.text.slice(0, 500),
        },
        { status: 400 }
      );
    }

    const taskId = runData.json?.data?.taskId;
    if (!taskId) {
      if (dedupKey) dedupMap.delete(dedupKey);
      return NextResponse.json(
        { error: '提交成功但未返回 taskId', upstream: runData.json },
        { status: 400 }
      );
    }

    if (dedupKey) {
      dedupMap.set(dedupKey, {
        state: 'submitted',
        taskId,
        createdAt: Date.now(),
      });
    }

    return NextResponse.json({
      ok: true,
      requestId: requestId || null,
      task_id: taskId,
      matchedFields,
      unmatchedInputKeys,
      raw: runData.json,
    });
  } catch (error: unknown) {
    // 提交环节异常时，清理 inflight 记录（若存在）
    try {
      const body = await request.clone().json();
      const requestId = String(body?.requestId || '').trim();
      if (requestId) {
        const sessionUser = await getSessionUserFromRequest(request);
        const ownerKey = sessionUser?.id || 'anonymous';
        getRunDedupMap().delete(`${ownerKey}:${requestId}`);
      }
    } catch {
      // ignore cleanup failure
    }
    console.error('[RUN_OPENAPI] exception:', error);
    const message = error instanceof Error ? error.message : 'unknown error';
    return NextResponse.json(
      { error: `服务器错误: ${message}` },
      { status: 500 }
    );
  }
}
