import { Image as ImageIcon, Video, type LucideIcon } from 'lucide-react';

export type WorkflowInput = {
  key: string;
  label: string;
  type: 'text' | 'number' | 'audio';
  placeholder?: string;
  defaultValue?: string | number;
  min?: number;
  max?: number;
  step?: number;
};

export type Workflow = {
  id: number;
  slug: string;
  title: string;
  enTitle?: string;
  description: string;
  category: string;
  time: string;
  icon: LucideIcon;
  workflowId: string; // 这里实际存 webappId（兼容你现有前端字段名）
  mediaType: 'image' | 'audio' | 'video';
  maxWaitMs: number;
  coverImage?: string;
  inputs: WorkflowInput[];
};

export const workflows: Workflow[] = [
  {
    id: 1,
    slug: 'beauty-redraw',
    title: '文生图美女胸部调节',
    enTitle: 'Image Redraw & Refinement',
    description: '一键生成高质量人像',
    category: '人像处理',
    time: '20s',
    icon: ImageIcon,
    workflowId: '2037569263141134337', // webappId
    mediaType: 'image',
    maxWaitMs: 10 * 60 * 1000,
    coverImage: 'https://dundun2026.oss-cn-guangzhou.aliyuncs.com/waterfalls/20260329_2aba53eae3ef.jpg',
    inputs: [
      {
        key: 'text',
        label: '提示词',
        type: 'text',
        placeholder: '一个穿着黑色连衣裙的美女',
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
  },
  {
    id: 2,
    slug: 'voice-style-replace',
    title: '口播音色替换',
    enTitle: 'Voice Style Replace',
    description: '上传参考音频并生成结果',
    category: '音色替换',
    time: '30s',
    icon: Video,
    workflowId: '2037571485572800513', // webappId
    mediaType: 'audio',
    maxWaitMs: 50 * 60 * 1000,
    coverImage: 'https://dundun2026.oss-cn-guangzhou.aliyuncs.com/waterfalls/20260321_297fc59b45ba.jpg',
    inputs: [
      {
        key: 'text',
        label: '提示词或脚本',
        type: 'text',
        placeholder: '请输入要转换的文本内容',
      },
      {
        key: 'audio',
        label: '上传参考音频',
        type: 'audio',
      },
    ],
  },
];

export function getWorkflowBySlug(slug: string) {
  return workflows.find((wf) => wf.slug === slug);
}

export function getWorkflowPointCost(workflow?: Pick<Workflow, 'title' | 'category'> | null) {
  if (!workflow) return 12;

  const text = `${workflow.title} ${workflow.category}`;
  if (/视频/.test(text)) return 15;
  if (/音色|音频|配音|口播/.test(text)) return 18;
  return 12;
}

export function getWorkflowPointCostById(workflowId: string) {
  const workflow = workflows.find((wf) => wf.workflowId === workflowId);
  return getWorkflowPointCost(workflow);
}

export function getWorkflowById(workflowId: string) {
  return workflows.find((wf) => wf.workflowId === workflowId);
}

export function getWorkflowMediaTypeById(workflowId: string) {
  return getWorkflowById(workflowId)?.mediaType || 'image';
}

export function getWorkflowDefaultMaxWaitMsById(workflowId: string) {
  const workflow = getWorkflowById(workflowId);
  if (workflow) return workflow.maxWaitMs;

  const text = `${workflowId}`;
  if (/video|视频/i.test(text)) return 60 * 60 * 1000;
  if (/audio|音|voice|口播/i.test(text)) return 50 * 60 * 1000;
  return 10 * 60 * 1000;
}
