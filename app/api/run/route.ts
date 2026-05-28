import { NextRequest, NextResponse } from 'next/server';
import { getGlobalStopEnabled } from '@/lib/points';
import { getSessionUserFromRequest } from '@/lib/server-auth';
import { prisma } from '@/lib/prisma';
import { WEBAPP_INPUT_ALIASES } from '@/lib/workflows';
import {
  getApiCallDemoNodeInfoList,
  getRunningHubApiKey,
  runAiApp,
  sanitizeRunningHubLog,
  uploadFileBufferToRunningHub,
  uploadFileToRunningHub,
} from '@/lib/runninghub';
import { deleteTempFileFromOss, getTempFileBufferFromOss } from '@/lib/temp-file-storage';

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
  fieldType?: string;
};

type RhFilePayload = {
  __rh_file: true;
  fileName: string;
  dataUrl: string;
};

type RhTempFilePayload = {
  __rh_file_key: true;
  fileKey: string;
  fileName?: string;
  contentType?: string;
};

const FILE_FIELD_TYPES = new Set(['IMAGE', 'AUDIO', 'VIDEO']);
const NUMBER_FIELD_TYPES = new Set(['INT', 'FLOAT', 'NUMBER']);
const STRING_FIELD_TYPES = new Set(['STRING', 'TEXT', 'COMBO', 'LIST']);
const AUDIO_FIELD_TYPES = new Set(['AUDIO']);
const IMAGE_FIELD_TYPES = new Set(['IMAGE']);
const VIDEO_FIELD_TYPES = new Set(['VIDEO']);

function isRhFilePayload(v: unknown): v is RhFilePayload {
  if (!v || typeof v !== 'object') return false;
  const obj = v as Record<string, unknown>;
  return obj.__rh_file === true && typeof obj.dataUrl === 'string';
}

function isRhTempFilePayload(v: unknown): v is RhTempFilePayload {
  if (!v || typeof v !== 'object') return false;
  const obj = v as Record<string, unknown>;
  return obj.__rh_file_key === true && typeof obj.fileKey === 'string';
}

function normalizeFieldName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function getAliases(webappId: string, inputKey: string) {
  const custom = WEBAPP_INPUT_ALIASES[webappId]?.[inputKey] ?? [];
  return Array.from(new Set([inputKey, ...custom]));
}

function getPreferredFileFieldTypes(inputKey: string): Set<string> | null {
  if (inputKey === 'audio') return AUDIO_FIELD_TYPES;
  if (inputKey === 'image' || inputKey === 'image_ref' || inputKey === 'image_ref2') return IMAGE_FIELD_TYPES;
  if (inputKey === 'video') return VIDEO_FIELD_TYPES;
  return null;
}

export async function POST(request: NextRequest) {
  const apiKey = getRunningHubApiKey();
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
          select: { id: true, account: true, username: true, role: true, points: true, taskBlocked: true },
        });
        if (internalUser) sessionUser = internalUser;
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

    const webappId = String(body.webappId || body.workflowId || '').trim();

    // 检查该AI应用是否已被全局禁用（因下架/不可用自动禁用）
    if (webappId) {
      const disableKey = `workflow_disabled_${webappId}`;
      const disableSetting = await prisma.systemSetting.findUnique({ where: { key: disableKey } });
      if (disableSetting) {
        try {
          const parsed = JSON.parse(disableSetting.value) as { disabled?: boolean; reason?: string };
          if (parsed.disabled) {
            return NextResponse.json(
              { error: `该AI应用暂时不可用，请联系管理员（原因：${parsed.reason || '应用已下架'}）` },
              { status: 503 }
            );
          }
        } catch { /* ignore */ }
      }
    }
    const inputs = (body.inputs || {}) as Record<string, unknown>;
    const requestId = String(body.requestId || '').trim();
    const ownerKey = sessionUser.id;

    const dedupMap = getRunDedupMap();
    purgeExpiredRunDedup(dedupMap);
    const dedupKey = requestId ? `${ownerKey}:${requestId}` : '';

    if (dedupKey) {
      const existing = dedupMap.get(dedupKey);
      if (existing?.state === 'submitted' && existing.taskId) {
        return NextResponse.json({
          ok: true, duplicate: true, requestId,
          task_id: existing.taskId, matchedFields: {}, unmatchedInputKeys: [], raw: { duplicate: true },
        });
      }

      if (existing?.state === 'inflight') {
        const start = Date.now();
        while (Date.now() - start < INFLIGHT_WAIT_MS) {
          await sleep(120);
          const latest = dedupMap.get(dedupKey);
          if (latest?.state === 'submitted' && latest.taskId) {
            return NextResponse.json({
              ok: true, duplicate: true, requestId,
              task_id: latest.taskId, matchedFields: {}, unmatchedInputKeys: [], raw: { duplicate: true },
            });
          }
          if (!latest) break;
        }
        return NextResponse.json({ error: '同 requestId 请求正在处理中，请稍后重试', requestId }, { status: 409 });
      }

      dedupMap.set(dedupKey, { state: 'inflight', createdAt: Date.now() });
    }

    if (!webappId) {
      return NextResponse.json({ error: '缺少 webappId/workflowId' }, { status: 400 });
    }

    // 1) 获取节点可编辑信息（带短期缓存）
    let nodeInfoList: NodeInfo[] = [];
    let demoCached = false;
    try {
      const demoResult = await getApiCallDemoNodeInfoList(apiKey, webappId);
      nodeInfoList = (demoResult.nodeInfoList || []) as NodeInfo[];
      demoCached = Boolean(demoResult.cached);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : '获取 nodeInfoList 失败';
      return NextResponse.json({ error: message }, { status: 400 });
    }

    const applyInputs = async (sourceNodeInfoList: NodeInfo[]) => {
      const updatedNodeInfoList: NodeInfo[] = sourceNodeInfoList.map((n) => ({ ...n }));
      const matchedFields: Record<string, string> = {};
      const unmatchedInputKeys: string[] = [];
      const usedTargets = new Set<string>();

      for (const [inputKey, incoming] of Object.entries(inputs)) {
        if (incoming === undefined || incoming === null || incoming === '') continue;

        const aliases = getAliases(webappId, inputKey);
        const aliasSet = new Set(aliases);
        const normalizedAliasSet = new Set(aliases.map(normalizeFieldName));

        let candidates = updatedNodeInfoList.filter((n) => aliasSet.has(n.fieldName));
        if (candidates.length === 0) {
          candidates = updatedNodeInfoList.filter((n) => normalizedAliasSet.has(normalizeFieldName(String(n.fieldName || ''))));
        }
        const isFilePayload = isRhFilePayload(incoming) || isRhTempFilePayload(incoming);
        if (candidates.length === 0 && isFilePayload) {
          const preferredTypes = getPreferredFileFieldTypes(inputKey);
          if (preferredTypes) {
            candidates = updatedNodeInfoList.filter((n) => preferredTypes.has(String(n.fieldType || '').toUpperCase()));
          }
          if (candidates.length === 0) {
            candidates = updatedNodeInfoList.filter((n) => FILE_FIELD_TYPES.has(String(n.fieldType || '').toUpperCase()));
          }
        }
        if (candidates.length === 0 && typeof incoming === 'number') {
          candidates = updatedNodeInfoList.filter((n) => NUMBER_FIELD_TYPES.has(String(n.fieldType || '').toUpperCase()));
        }
        if (candidates.length === 0 && typeof incoming === 'string') {
          candidates = updatedNodeInfoList.filter((n) => STRING_FIELD_TYPES.has(String(n.fieldType || '').toUpperCase()));
        }

        if (candidates.length === 0) {
          unmatchedInputKeys.push(inputKey);
          continue;
        }

        const unused = candidates.find((n) => !usedTargets.has(`${n.nodeId}.${n.fieldName}`));
        let target = unused || candidates[0];
        if (isFilePayload) {
          const preferredTypes = getPreferredFileFieldTypes(inputKey);
          target =
            candidates.find(
              (n) =>
                (preferredTypes
                  ? preferredTypes.has(String(n.fieldType || '').toUpperCase())
                  : FILE_FIELD_TYPES.has(String(n.fieldType || '').toUpperCase())) &&
                !usedTargets.has(`${n.nodeId}.${n.fieldName}`)
            ) ||
            candidates.find((n) =>
              preferredTypes
                ? preferredTypes.has(String(n.fieldType || '').toUpperCase())
                : FILE_FIELD_TYPES.has(String(n.fieldType || '').toUpperCase())
            ) ||
            candidates[0];
          let uploaded = '';
          if (isRhFilePayload(incoming)) {
            uploaded = await uploadFileToRunningHub(apiKey, incoming);
          } else {
            const tempFile = await getTempFileBufferFromOss(String(incoming.fileKey || ''));
            uploaded = await uploadFileBufferToRunningHub(apiKey, {
              fileName: String(incoming.fileName || 'upload.bin'),
              contentType: String(incoming.contentType || tempFile.contentType || 'application/octet-stream'),
              buffer: tempFile.buffer,
            });
            await deleteTempFileFromOss(String(incoming.fileKey || ''));
          }
          target.fieldValue = uploaded;
        } else {
          target.fieldValue = incoming;
        }

        matchedFields[inputKey] = `${target.nodeId}.${target.fieldName}`;
        usedTargets.add(`${target.nodeId}.${target.fieldName}`);
      }

      const availableFields = updatedNodeInfoList.map((n) => ({ nodeId: n.nodeId, fieldName: n.fieldName, fieldType: n.fieldType }));
      return { updatedNodeInfoList, matchedFields, unmatchedInputKeys, availableFields };
    };

    // 2) 用 inputs 按 fieldName 覆盖 fieldValue（文件先上传）
    let { updatedNodeInfoList, matchedFields, unmatchedInputKeys, availableFields } = await applyInputs(nodeInfoList);

    // 兜底：首次命中缓存且匹配字段为 0 时，绕过缓存重拉一次再匹配
    if (Object.keys(matchedFields).length === 0 && demoCached) {
      try {
        const refreshed = await getApiCallDemoNodeInfoList(apiKey, webappId, { forceRefresh: true });
        const remapped = await applyInputs((refreshed.nodeInfoList || []) as NodeInfo[]);
        updatedNodeInfoList = remapped.updatedNodeInfoList;
        matchedFields = remapped.matchedFields;
        unmatchedInputKeys = remapped.unmatchedInputKeys;
        availableFields = remapped.availableFields;
      } catch {
        // ignore refresh failure and keep first pass result
      }
    }

    if (Object.keys(matchedFields).length === 0) {
      return NextResponse.json(
        { error: '未匹配到任何可修改字段，请检查 inputs key 与应用参数是否一致', unmatchedInputKeys, availableFields },
        { status: 400 }
      );
    }

    // 3) 提交任务
    const { runRes, runData } = await runAiApp(apiKey, webappId, updatedNodeInfoList);
    console.log('[RUN_OPENAPI] webappId:', webappId, '| requestId:', requestId || 'N/A');
    console.log('[RUN_OPENAPI] matched:', matchedFields, '| unmatched:', unmatchedInputKeys);
    console.log('[RUN_OPENAPI] run status:', runRes.status, '| raw:', sanitizeRunningHubLog(runData.text));

    if (!runData.json || runData.json.code !== 0) {
      if (dedupKey) dedupMap.delete(dedupKey);
      return NextResponse.json(
        {
          error: runData.json?.msg || '提交任务失败',
          upstreamStatus: runRes.status,
          upstream: sanitizeRunningHubLog(runData.json ?? runData.text.slice(0, 500)),
        },
        { status: 400 }
      );
    }

    const taskId = runData.json?.data?.taskId;
    if (!taskId) {
      if (dedupKey) dedupMap.delete(dedupKey);
      return NextResponse.json({ error: '提交成功但未返回 taskId', upstream: runData.json }, { status: 400 });
    }

    if (dedupKey) {
      dedupMap.set(dedupKey, { state: 'submitted', taskId, createdAt: Date.now() });
    }

    return NextResponse.json({ ok: true, requestId: requestId || null, task_id: taskId, matchedFields, unmatchedInputKeys, raw: runData.json });
  } catch (error: unknown) {
    try {
      const body = await request.clone().json();
      const reqId = String(body?.requestId || '').trim();
      if (reqId) {
        const su = await getSessionUserFromRequest(request);
        getRunDedupMap().delete(`${su?.id || 'anonymous'}:${reqId}`);
      }
    } catch { /* ignore */ }
    console.error('[RUN_OPENAPI] exception:', error);
    const message = error instanceof Error ? error.message : 'unknown error';
    return NextResponse.json({ error: `服务器错误: ${message}` }, { status: 500 });
  }
}
