/**
 * 工作流（AI应用）配置文件
 *
 * 如何新增一个AI应用：
 * 1. 在 WORKFLOW_REGISTRY 数组末尾添加一个新对象
 * 2. 填写最简 8 个必填字段：
 *    id / slug / title / description / category / workflowId / mediaType / inputs
 * 3. 可选字段按需补充：enTitle / time / pointsCost / coverImage / disabled
 * 4. 无需修改其他任何文件，主页会自动显示新应用
 *
 * 如何禁用/下架一个AI应用：
 * 1. 将对应条目的 disabled: true 即可（不会显示在主页）
 * 2. 或直接删除该条目
 */

export type WorkflowInputType = 'text' | 'number' | 'audio' | 'image' | 'video';

export type WorkflowInput = {
  key: string;
  label: string;
  type: WorkflowInputType;
  placeholder?: string;
  defaultValue?: string | number;
  min?: number;
  max?: number;
  step?: number;
  required?: boolean;
};

export type WorkflowMediaType = 'image' | 'audio' | 'video';

export type Workflow = {
  id: number;
  /** 路由唯一标识，只用小写英文+数字+中划线，例如 product-bg-replace */
  slug: string;
  title: string;
  enTitle?: string;
  description: string;
  category: string;
  /** 预计耗时描述，如 "20s" */
  time?: string;
  /** RunningHub 的 webappId，前端字段名保持 workflowId 兼容 */
  workflowId: string;
  mediaType: WorkflowMediaType;
  /** 积分消耗，不填则按成本模型（运行时长+额外成本）自动推算 */
  pointsCost?: number;
  /** 成本模型：预估运行时长（秒） */
  runtimeSeconds?: number;
  /** 成本模型：固定额外人民币成本（元） */
  extraCostYuan?: number;
  /** 成本模型：固定额外 RH 币成本 */
  extraCostRhCoins?: number;
  coverImage?: string;
  inputs: WorkflowInput[];
  /** 设为 true 则不在主页显示（软下架） */
  disabled?: boolean;
};

const DEFAULT_WORKFLOW_COVER_IMAGE =
  '/workflows/default.jpg';

/**
 * 首页 AI 应用 slug 主图清单（按这个表上传/维护即可）
 * - key: slug（与 /workflow-app/[slug] 一致）
 * - value: 主图 URL（可先留默认图，后续再替换）
 *
 * 维护方式：
 * 1) 你新增应用后，在这里补一行对应 slug
 * 2) 图片未准备好时先保留 DEFAULT_WORKFLOW_COVER_IMAGE（本地默认图）
 * 3) 运行时会优先读取这里；不存在则自动回退默认图
 *
 * 本地图片目录：
 * - 把图片放到：/public/workflows/
 * - 这里填写：/workflows/xxx.jpg
 */
const WORKFLOW_COVER_IMAGE_ITEMS: Array<{
  name: string;
  slug: string;
  coverImage: string;
}> = [
  { name: '胸部模拟器', slug: 'beauty-redraw', coverImage: '/workflows/ComfyUI_00005_kgxxh_1777214351.jpg' },
  { name: '音色替换', slug: 'voice-style-replace', coverImage: '/workflows/ComfyUI_00006_hjklz_1777214707.jpg' },
  { name: '动作迁移（15s）', slug: 'motion-transfer-consistent-dance', coverImage: '/workflows/ComfyUI_00004_zzpjj_1777213864.jpg' },
  { name: '替换人物肤色换成欧美模特', slug: 'replace-skin-tone-euro-model', coverImage: '/workflows/ComfyUI_00007_rbeox_1777216984.jpg' },
  { name: '人物一致美甲替换', slug: 'consistent-person-nail-change', coverImage: '/workflows/ComfyUI_00003_vmgej_1777216367.jpg' },
  { name: '换头超强一致性', slug: 'qwen-face-swap-ultra-consistent', coverImage: '/workflows/ComfyUI_00016_qvsip_1777218044.jpg' },
  { name: '电商主图风格参考', slug: 'cn-ecommerce-main-image-restyle', coverImage: '/workflows/ComfyUI_00014_zykmr_1777218821.jpg' },
  { name: '爆款封面复刻', slug: 'xiaohongshu-douyin-cover-remake', coverImage: '/workflows/ComfyUI_00015_tlpgq_1777219306.jpg' },
  { name: '图片去水印', slug: 'qwen-image-watermark-removal', coverImage: '/workflows/ComfyUI_00023_sopob_1777219689.jpg' },
  { name: '衣物提取（女）', slug: 'garment-extract-women', coverImage: '/workflows/ComfyUI_00016_zjbpj_1777219916.jpg' },
  { name: '衣物提取（儿童）', slug: 'garment-extract-kids', coverImage: '/workflows/ComfyUI_00025_ylgac_1777220084.jpg' },
  { name: '换装产品一致（2K）', slug: 'outfit-change-product-consistent-2k', coverImage: '/workflows/ComfyUI_00027_hgabe_1777220499.jpg' },
  { name: '换装产品一致（4K）', slug: 'outfit-change-product-consistent-4k', coverImage: '/workflows/ComfyUI_00029_dpjtp_1777220730.jpg' },
  { name: '换装+替换背景', slug: 'outfit-bg-accessory-combo', coverImage: '/workflows/ComfyUI_00031_ltzme_1777221645.jpg' },
];

export const WORKFLOW_COVER_IMAGE_MAP: Record<string, string> = Object.fromEntries(
  WORKFLOW_COVER_IMAGE_ITEMS.map((item) => [item.slug, item.coverImage])
);

function getWorkflowCoverImage(slug: string): string {
  return WORKFLOW_COVER_IMAGE_MAP[slug] || DEFAULT_WORKFLOW_COVER_IMAGE;
}

// ─────────────────────────────────────────────
// 在这里添加/修改/删除 AI 应用
// ─────────────────────────────────────────────
const WORKFLOW_REGISTRY: Workflow[] = [
  {
    id: 1,
    slug: 'beauty-redraw',
    title: '胸部模拟器',
    enTitle: 'Image Redraw & Refinement',
    description: '一键生成高质量人像',
    category: '人像处理',
    time: '40s',
    workflowId: '2037569263141134337',
    mediaType: 'image',
    runtimeSeconds: 40,
    extraCostRhCoins: 14,
    coverImage: getWorkflowCoverImage('beauty-redraw'),
    inputs: [
      {
        key: 'text',
        label: '提示词',
        type: 'text',
        placeholder: '一个穿着黑色连衣裙的美女',
        required: true,
      },
      {
        key: 'value',
        label: '调节强度',
        type: 'number',
        defaultValue: 1,
        min: -1,
        max: 2,
        step: 0.1,
      },
    ],
    disabled: false,
  },
  {
    id: 2,
    slug: 'voice-style-replace',
    title: '音色替换',
    enTitle: 'Voice Style Replace',
    description: '上传两个音频进行音色替换并生成结果',
    category: '音色替换',
    time: '20m',
    workflowId: '2037571485572800513',
    mediaType: 'audio',
    runtimeSeconds: 20 * 60,
    extraCostRhCoins: 9,
    coverImage: getWorkflowCoverImage('voice-style-replace'),
    inputs: [
      {
        key: 'audio',
        label: '源音频',
        type: 'audio',
        required: true,
      },
      {
        key: 'audio_ref',
        label: '目标音色音频',
        type: 'audio',
        required: true,
      },
    ],
    disabled: false,
  },
  {
    id: 3,
    slug: 'motion-transfer-consistent-dance',
    title: '动作迁移（15s）',
    description: '保持人物一致性，驱动指定舞蹈动作并输出短视频',
    category: '动作迁移',
    workflowId: '2046971458974388225',
    mediaType: 'video',
    time: '4m',
    runtimeSeconds: 4 * 60,
    extraCostRhCoins: 66,
    coverImage: getWorkflowCoverImage('motion-transfer-consistent-dance'),
    inputs: [
      { key: 'image', label: '人物原图', type: 'image', required: true },
      { key: 'video', label: '动作参考视频', type: 'video', required: true },
    ],
    disabled: false,
  },
  {
    id: 4,
    slug: 'replace-skin-tone-euro-model',
    title: '替换人物肤色换成欧美模特',
    description: '在保持人物结构基础上，将肤色与风格调整为欧美模特质感',
    category: '人物编辑',
    workflowId: '2046975040763203585',
    mediaType: 'image',
    time: '4m',
    runtimeSeconds: 4 * 60,
    coverImage: getWorkflowCoverImage('replace-skin-tone-euro-model'),
    inputs: [{ key: 'image', label: '原图', type: 'image', required: true }],
    disabled: false,
  },
  {
    id: 5,
    slug: 'consistent-person-nail-change',
    title: '人物一致美甲替换',
    description: '保持人物一致性，仅替换手部美甲样式与颜色',
    category: '人物编辑',
    workflowId: '2046976751133270017',
    mediaType: 'image',
    time: '40s',
    runtimeSeconds: 40,
    extraCostYuan: 0.16,
    coverImage: getWorkflowCoverImage('consistent-person-nail-change'),
    inputs: [
      { key: 'image', label: '人物原图', type: 'image', required: true },
      { key: 'image_ref', label: '美甲参考图', type: 'image', required: true },
    ],
    disabled: false,
  },
  {
    id: 6,
    slug: 'qwen-face-swap-ultra-consistent',
    title: '换头超强一致性',
    description: '基于Qwen能力进行高一致性换头',
    category: '人脸处理',
    workflowId: '2046978094795333633',
    mediaType: 'image',
    time: '2m',
    runtimeSeconds: 2 * 60,
    extraCostRhCoins: 27,
    coverImage: getWorkflowCoverImage('qwen-face-swap-ultra-consistent'),
    inputs: [
      { key: 'image', label: '人物原图', type: 'image', required: true },
      { key: 'image_ref', label: '目标人脸图', type: 'image', required: true },
    ],
    disabled: false,
  },
  {
    id: 7,
    slug: 'cn-ecommerce-main-image-restyle',
    title: '电商主图风格参考',
    description: '按参考图复刻电商主图风格与版式',
    category: '电商设计',
    workflowId: '2046979527011737601',
    mediaType: 'image',
    time: '50s',
    runtimeSeconds: 50,
    extraCostYuan: 0.16,
    coverImage: getWorkflowCoverImage('cn-ecommerce-main-image-restyle'),
    inputs: [
      { key: 'image', label: '商品原图', type: 'image', required: true },
      { key: 'image_ref', label: '风格参考图', type: 'image', required: true },
      { key: 'text', label: '补充文案', type: 'text', required: false, placeholder: '可选：标题、卖点或品牌词' },
    ],
    disabled: false,
  },
  {
    id: 8,
    slug: 'xiaohongshu-douyin-cover-remake',
    title: '爆款封面复刻',
    description: '复刻爆款封面风格，适配小红书与抖音',
    category: '封面设计',
    workflowId: '2046984963425312770',
    mediaType: 'image',
    time: '3m',
    runtimeSeconds: 3 * 60,
    extraCostYuan: 0.16,
    coverImage: getWorkflowCoverImage('xiaohongshu-douyin-cover-remake'),
    inputs: [
      { key: 'image', label: '素材原图', type: 'image', required: true },
      { key: 'image_ref', label: '封面参考图', type: 'image', required: true },
      { key: 'text', label: '补充文案', type: 'text', required: false, placeholder: '可选：标题、卖点或品牌词' },
    ],
    disabled: false,
  },
  {
    id: 9,
    slug: 'qwen-image-watermark-removal',
    title: '图片去水印',
    description: '智能去除图片水印并尽量还原背景细节',
    category: '图片修复',
    workflowId: '2046986426746671106',
    mediaType: 'image',
    time: '60s',
    runtimeSeconds: 60,
    coverImage: getWorkflowCoverImage('qwen-image-watermark-removal'),
    inputs: [{ key: 'image', label: '原图', type: 'image', required: true }],
    disabled: false,
  },
  {
    id: 10,
    slug: 'garment-extract-women',
    title: '衣物提取（女）',
    description: '提取女装服饰主体，便于后续换装或商品展示',
    category: '服饰处理',
    workflowId: '2046989524550553601',
    mediaType: 'image',
    time: '60s',
    runtimeSeconds: 60,
    coverImage: getWorkflowCoverImage('garment-extract-women'),
    inputs: [{ key: 'image', label: '服装原图（女）', type: 'image', required: true }],
    disabled: false,
  },
  {
    id: 11,
    slug: 'garment-extract-kids',
    title: '衣物提取（儿童）',
    description: '提取童装服饰主体，适配儿童款式场景',
    category: '服饰处理',
    workflowId: '2046991872580653058',
    mediaType: 'image',
    time: '60s',
    runtimeSeconds: 60,
    coverImage: getWorkflowCoverImage('garment-extract-kids'),
    inputs: [{ key: 'image', label: '服装原图（儿童）', type: 'image', required: true }],
    disabled: false,
  },
  {
    id: 12,
    slug: 'outfit-change-product-consistent-2k',
    title: '换装产品一致（2K）',
    description: '2K 输出，保持产品细节与版型一致的换装效果',
    category: '换装',
    workflowId: '2046993523433541634',
    mediaType: 'image',
    time: '40s',
    runtimeSeconds: 40,
    extraCostYuan: 0.25,
    coverImage: getWorkflowCoverImage('outfit-change-product-consistent-2k'),
    inputs: [
      { key: 'image', label: '人物原图', type: 'image', required: true },
      { key: 'image_ref', label: '服装参考图', type: 'image', required: true },
    ],
    disabled: false,
  },
  {
    id: 13,
    slug: 'outfit-change-product-consistent-4k',
    title: '换装产品一致（4K）',
    description: '4K 输出，保持产品细节与版型一致的高精换装效果',
    category: '换装',
    workflowId: '2046994876469874689',
    mediaType: 'image',
    time: '90s',
    runtimeSeconds: 90,
    extraCostYuan: 0.5,
    coverImage: getWorkflowCoverImage('outfit-change-product-consistent-4k'),
    inputs: [
      { key: 'image', label: '人物原图', type: 'image', required: true },
      { key: 'image_ref', label: '服装参考图', type: 'image', required: true },
    ],
    disabled: false,
  },
  {
    id: 14,
    slug: 'outfit-bg-accessory-combo',
    title: '换装+替换背景',
    description: '一键完成换装、换背景与配饰补全',
    category: '组合编辑',
    workflowId: '2046996811847569410',
    mediaType: 'image',
    time: '140s',
    runtimeSeconds: 140,
    extraCostYuan: 0.36,
    coverImage: getWorkflowCoverImage('outfit-bg-accessory-combo'),
    inputs: [
      { key: 'image', label: '人物原图', type: 'image', required: true },
      { key: 'image_ref', label: '服装风格参考图', type: 'image', required: true },
      { key: 'image_ref2', label: '背景配饰参考图', type: 'image', required: true },
    ],
    disabled: false,
  },
];

// ─────────────────────────────────────────────
// 以下为工具函数，无需修改
// ─────────────────────────────────────────────

/** 获取所有启用的工作流（过滤掉 disabled） */
export const workflows: Workflow[] = WORKFLOW_REGISTRY.filter((wf) => !wf.disabled);

export const PRICING_BASELINE = {
  // 1 元 = 250 RH 币（由 10 元 = 2500 RH 币换算）
  rhCoinToYuan: 10 / 2500,
  // 与后台默认配置保持一致：运行时长成本
  runningCostYuanPerHour: 6,
  // 与后台默认成功结算倍率保持一致（约 78.7% 毛利）
  successChargeMultiplier: 4.7,
  // 预占积分按安全系数兜底
  safetyFactor: 1.03,
} as const;

type WorkflowCostProfile = Pick<Workflow, 'runtimeSeconds' | 'extraCostYuan' | 'extraCostRhCoins'>;

const WORKFLOW_COST_PROFILE_OVERRIDES: Record<string, WorkflowCostProfile> = {
  // 历史/外部登记ID兼容：口播音色替换
  '2036111341429202945': {
    runtimeSeconds: 20 * 60,
    extraCostRhCoins: 9,
  },
  // 历史/外部登记ID兼容：文生图美女胸部调节
  '2037199977641938945': {
    runtimeSeconds: 40,
    extraCostRhCoins: 14,
  },
};

export function estimateWorkflowCostYuan(
  workflow:
    | WorkflowCostProfile
    | null
    | undefined,
  options?: {
    runningCostYuanPerHour?: number;
    elapsedMsOverride?: number;
  }
): number {
  if (!workflow) return 0;
  const runtimeSecondsFromElapsed =
    options?.elapsedMsOverride != null && Number.isFinite(Number(options.elapsedMsOverride))
      ? Math.max(0, Number(options.elapsedMsOverride)) / 1000
      : null;
  const runtimeSeconds =
    runtimeSecondsFromElapsed != null
      ? runtimeSecondsFromElapsed
      : Math.max(0, Number(workflow.runtimeSeconds || 0));
  const runtimeHours = runtimeSeconds / 3600;
  const runningCost = Math.max(0, Number(options?.runningCostYuanPerHour ?? PRICING_BASELINE.runningCostYuanPerHour));
  const runtimeCostYuan = runtimeHours * runningCost;
  const extraYuan = Math.max(0, Number(workflow.extraCostYuan || 0));
  const extraRhCoins = Math.max(0, Number(workflow.extraCostRhCoins || 0));
  const extraRhYuan = extraRhCoins * PRICING_BASELINE.rhCoinToYuan;
  return runtimeCostYuan + extraYuan + extraRhYuan;
}

export function estimateWorkflowPrechargePoints(
  workflow:
    | WorkflowCostProfile
    | null
    | undefined,
  options?: {
    runningCostYuanPerHour?: number;
    successChargeMultiplier?: number;
    safetyFactor?: number;
  }
): number {
  const costYuan = estimateWorkflowCostYuan(workflow, {
    runningCostYuanPerHour: options?.runningCostYuanPerHour,
  });
  if (costYuan <= 0) return 0;
  const multiplier = Math.max(0, Number(options?.successChargeMultiplier ?? PRICING_BASELINE.successChargeMultiplier));
  const safetyFactor = Math.max(1, Number(options?.safetyFactor ?? PRICING_BASELINE.safetyFactor));
  return Math.ceil(costYuan * 100 * multiplier * safetyFactor);
}

/** 根据 slug 查找工作流 */
export function getWorkflowBySlug(slug: string): Workflow | undefined {
  return workflows.find((wf) => wf.slug === slug);
}

/** 根据 webappId 查找工作流（含已禁用的，用于任务记录查询） */
export function getWorkflowById(workflowId: string): Workflow | undefined {
  return WORKFLOW_REGISTRY.find((wf) => wf.workflowId === workflowId);
}

/** 根据 webappId 判断该应用是否已被禁用/下架 */
export function isWorkflowDisabled(workflowId: string): boolean {
  const wf = WORKFLOW_REGISTRY.find((w) => w.workflowId === workflowId);
  return !wf || wf.disabled === true;
}

/** 根据 webappId 获取成本画像（优先注册表，缺失时走兼容映射） */
export function getWorkflowCostProfileById(workflowId: string): WorkflowCostProfile | null {
  const wf = getWorkflowById(workflowId);
  if (wf) {
    return {
      runtimeSeconds: wf.runtimeSeconds,
      extraCostYuan: wf.extraCostYuan,
      extraCostRhCoins: wf.extraCostRhCoins,
    };
  }
  return WORKFLOW_COST_PROFILE_OVERRIDES[workflowId] || null;
}

/** 获取工作流积分消耗 */
export function getWorkflowPointCost(
  workflow?: Pick<Workflow, 'title' | 'category' | 'mediaType' | 'pointsCost' | 'runtimeSeconds' | 'extraCostYuan' | 'extraCostRhCoins'> | null
): number {
  if (!workflow) return 12;
  if (workflow.pointsCost != null) return workflow.pointsCost;
  const modeledPoints = estimateWorkflowPrechargePoints(workflow);
  if (modeledPoints > 0) return modeledPoints;
  if (workflow.mediaType === 'video') return 15;
  if (workflow.mediaType === 'audio') return 18;
  // 兼容旧的文字匹配逻辑
  const text = `${workflow.title} ${workflow.category}`;
  if (/视频/.test(text)) return 15;
  if (/音色|音频|配音|口播/.test(text)) return 18;
  return 12;
}

/** 根据 webappId 获取积分消耗 */
export function getWorkflowPointCostById(workflowId: string): number {
  const wf = getWorkflowById(workflowId);
  if (wf) return getWorkflowPointCost(wf);

  const profile = getWorkflowCostProfileById(workflowId);
  if (profile) {
    const modeledPoints = estimateWorkflowPrechargePoints(profile);
    if (modeledPoints > 0) return modeledPoints;
  }

  return 12;
}

/** 根据 webappId 获取媒体类型 */
export function getWorkflowMediaTypeById(workflowId: string): WorkflowMediaType {
  return getWorkflowById(workflowId)?.mediaType ?? 'image';
}

/**
 * 字段名别名映射，key 为 webappId，value 为 { inputKey: [候选fieldName列表] }
 * run/route.ts 会用此做智能字段匹配，集中维护避免重复定义
 */
export const WEBAPP_INPUT_ALIASES: Record<string, Record<string, string[]>> = {
  // 文生图
  '2037569263141134337': {
    text: ['text', 'prompt'],
    value: ['value', 'strength', 'strength_model'],
  },
  // 口播音色替换
  '2037571485572800513': {
    audio: [
      'audio',
      'source_audio',
      'input_audio',
      'audio_in',
      'source',
      'src_audio',
      'audio1',
      'first_audio',
    ],
    audio_ref: [
      'reference_audio',
      'ref_audio',
      'audio_ref',
      'target_audio',
      'style_audio',
      'voice',
      'voice_audio',
      'voice_sample',
      'audio2',
      'second_audio',
      'input_audio_ref',
      'input_audio2',
      'wav',
      'input_wav',
    ],
  },
  // 动作迁移人物一致美女跳舞（15s）
  '2046971458974388225': {
    video: ['video', 'input_video', 'source_video', 'motion_video', 'reference_video'],
    image: ['image', 'input_image', 'source_image', 'character_image', 'reference_image'],
  },
  // 替换人物肤色换成欧美模特
  '2046975040763203585': {
    image: ['image', 'input_image', 'source_image'],
  },
  // 人物一致换美甲
  '2046976751133270017': {
    image: ['image', 'input_image', 'source_image', 'image1', 'first_image'],
    image_ref: ['image', 'reference_image', 'target_image', 'image2', 'second_image'],
  },
  // 换头Qwen超强一致性
  '2046978094795333633': {
    image: ['image', 'input_image', 'source_image', 'image1', 'first_image'],
    image_ref: ['image', 'reference_image', 'target_image', 'image2', 'second_image'],
  },
  // 国内电商主图仿图参考风格排版
  '2046979527011737601': {
    image: ['image', 'input_image', 'source_image', 'image1', 'first_image'],
    text: ['text', 'prompt', 'title', 'content'],
    image_ref: ['image', 'reference_image', 'style_image', 'image2', 'second_image'],
  },
  // 电商必备小红书抖音爆款封面复刻
  '2046984963425312770': {
    image: ['image', 'input_image', 'source_image', 'image1', 'first_image'],
    image_ref: ['image', 'reference_image', 'style_image', 'image2', 'second_image'],
    text: ['text', 'prompt', 'title', 'content'],
  },
  // Qwen图片去水印
  '2046986426746671106': {
    image: ['image', 'input_image', 'source_image'],
  },
  // 衣物提取（女）
  '2046989524550553601': {
    image: ['image', 'input_image', 'source_image'],
  },
  // 衣物提取（儿童）
  '2046991872580653058': {
    image: ['image', 'input_image', 'source_image'],
  },
  // 换装产品一致2K
  '2046993523433541634': {
    image: ['image', 'input_image', 'source_image', 'image1', 'first_image'],
    image_ref: ['image', 'reference_image', 'target_image', 'image2', 'second_image'],
  },
  // 换装产品一致4K
  '2046994876469874689': {
    image: ['image', 'input_image', 'source_image', 'image1', 'first_image'],
    image_ref: ['image', 'reference_image', 'target_image', 'image2', 'second_image'],
  },
  // 换装+替换人物背景+自带配饰
  '2046996811847569410': {
    image: ['image', 'input_image', 'source_image', 'image1', 'first_image'],
    image_ref: ['image', 'reference_image', 'style_image', 'image2', 'second_image'],
    image_ref2: ['image', 'background_image', 'accessory_image', 'image3', 'third_image'],
  },
};
