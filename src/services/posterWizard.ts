import fragmentLibrary from "../data/posterWizardFragments.json";
import {
  GenerationEngineError,
  type GenerationEngine
} from "./generationEngine";
import {
  executeGenerationTask,
  type GenerationWorkflowAdapters,
  type GenerationWorkflowResult
} from "./generationWorkflow";

export const POSTER_FRAGMENT_TYPES = ["theme", "copy", "style", "composition", "format"] as const;
export type PosterFragmentType = typeof POSTER_FRAGMENT_TYPES[number];

export interface PosterPromptFragment {
  id: string;
  label: string;
  type: PosterFragmentType;
  prompt: string;
}

export interface PosterWizardStep {
  id: PosterFragmentType;
  label: string;
  shortLabel: string;
}

export interface PosterWizardDraft {
  subject: string;
  title: string;
  subtitle: string;
  details: string;
  selections: Record<PosterFragmentType, string>;
}

export interface PosterPromptBundle {
  systemPrompt: string;
  userPrompt: string;
  combinedPrompt: string;
  aspectRatio: string;
  fragments: PosterPromptFragment[];
}

export const POSTER_SYSTEM_PROMPT = Object.freeze([
  "You are a senior poster art director and production designer.",
  "Preserve the source subject exactly: do not change its identity, facial features, product geometry, brand marks, proportions, or recognizable pixels.",
  "Build typography, graphic devices, color fields, and spatial composition around the preserved subject.",
  "Render every supplied headline and subtitle exactly as written. Do not translate, paraphrase, invent, or omit copy.",
  "Return one finished, print-ready poster image without mockup frames, watermarks, or explanatory text."
].join("\n"));

export const POSTER_WIZARD_STEPS: readonly PosterWizardStep[] = Object.freeze([
  { id: "theme", label: "主题", shortLabel: "主题" },
  { id: "copy", label: "文案", shortLabel: "文案" },
  { id: "style", label: "风格", shortLabel: "风格" },
  { id: "composition", label: "构图", shortLabel: "构图" },
  { id: "format", label: "画幅与预览", shortLabel: "预览" }
]);

const isFragmentType = (value: unknown): value is PosterFragmentType =>
  typeof value === "string" && (POSTER_FRAGMENT_TYPES as readonly string[]).includes(value);

const parseFragmentLibrary = (value: unknown): PosterPromptFragment[] => {
  if (!Array.isArray(value)) throw new Error("海报提示词片段库必须是数组");
  const ids = new Set<string>();
  const fragments = value.map((entry, index) => {
    if (!entry || typeof entry !== "object") throw new Error(`海报提示词片段 ${index + 1} 格式无效`);
    const candidate = entry as Record<string, unknown>;
    if (
      typeof candidate.id !== "string" || !candidate.id.trim() ||
      typeof candidate.label !== "string" || !candidate.label.trim() ||
      !isFragmentType(candidate.type) ||
      typeof candidate.prompt !== "string" || !candidate.prompt.trim()
    ) {
      throw new Error(`海报提示词片段 ${index + 1} 缺少 id、label、type 或 prompt`);
    }
    if (ids.has(candidate.id)) throw new Error(`海报提示词片段 ID 重复：${candidate.id}`);
    ids.add(candidate.id);
    return {
      id: candidate.id,
      label: candidate.label,
      type: candidate.type,
      prompt: candidate.prompt
    };
  });
  for (const type of POSTER_FRAGMENT_TYPES) {
    if (!fragments.some((fragment) => fragment.type === type)) {
      throw new Error(`海报提示词片段库缺少 ${type} 类型`);
    }
  }
  return fragments;
};

export const POSTER_PROMPT_FRAGMENTS: readonly PosterPromptFragment[] =
  Object.freeze(parseFragmentLibrary(fragmentLibrary));

export const getPosterFragments = (type: PosterFragmentType) =>
  POSTER_PROMPT_FRAGMENTS.filter((fragment) => fragment.type === type);

export const createDefaultPosterDraft = (): PosterWizardDraft => ({
  subject: "",
  title: "",
  subtitle: "",
  details: "",
  selections: Object.fromEntries(
    POSTER_FRAGMENT_TYPES.map((type) => [type, getPosterFragments(type)[0]?.id ?? ""])
  ) as Record<PosterFragmentType, string>
});

const FORMAT_ASPECT_RATIOS: Record<string, string> = {
  "format-4x5": "4:5",
  "format-3x4": "3:4",
  "format-square": "1:1",
  "format-wide": "16:9"
};

const cleanText = (value: string) => value.trim().replace(/\s+/g, " ");

export const validatePosterDraft = (draft: PosterWizardDraft) => {
  const subject = cleanText(draft.subject);
  const title = cleanText(draft.title);
  const subtitle = cleanText(draft.subtitle);
  const details = cleanText(draft.details);
  if (!subject) throw new Error("请输入海报主题");
  if (!title) throw new Error("请输入海报主标题");
  if (subject.length > 120) throw new Error("海报主题不能超过 120 个字符");
  if (title.length > 60) throw new Error("海报主标题不能超过 60 个字符");
  if (subtitle.length > 120) throw new Error("海报副标题不能超过 120 个字符");
  if (details.length > 300) throw new Error("补充要求不能超过 300 个字符");

  const fragments = POSTER_FRAGMENT_TYPES.map((type) => {
    const fragment = POSTER_PROMPT_FRAGMENTS.find((candidate) =>
      candidate.id === draft.selections[type] && candidate.type === type
    );
    if (!fragment) throw new Error(`请选择有效的${POSTER_WIZARD_STEPS.find((step) => step.id === type)?.label ?? type}`);
    return fragment;
  });
  return { subject, title, subtitle, details, fragments };
};

export const buildPosterPrompt = (draft: PosterWizardDraft): PosterPromptBundle => {
  const { subject, title, subtitle, details, fragments } = validatePosterDraft(draft);
  const copyLines = [
    `Campaign subject: ${subject}`,
    `Exact headline: ${JSON.stringify(title)}`,
    subtitle ? `Exact subtitle: ${JSON.stringify(subtitle)}` : "Exact subtitle: none",
    "Selected art-direction fragments:",
    ...fragments.map((fragment, index) => `${index + 1}. ${fragment.prompt}`),
    details ? `Additional user direction: ${details}` : "Additional user direction: none",
    "Keep the supplied copy legible, correctly spelled, and inside safe margins."
  ];
  const userPrompt = copyLines.join("\n");
  return {
    systemPrompt: POSTER_SYSTEM_PROMPT,
    userPrompt,
    combinedPrompt: `${POSTER_SYSTEM_PROMPT}\n\n${userPrompt}`,
    aspectRatio: FORMAT_ASPECT_RATIOS[draft.selections.format] ?? "4:5",
    fragments
  };
};

export interface PosterWorkflowInput {
  engine: GenerationEngine;
  draft: PosterWizardDraft;
  baseImageBase64: string;
  timeoutMs: number;
  feather: number;
  taskId: string;
  adapters: GenerationWorkflowAdapters;
  isCurrent: () => boolean;
  onRequestStart?: () => void | Promise<void>;
  onRequestSettled?: () => void | Promise<void>;
  onLayerPlaced?: (layerId: number) => void | Promise<void>;
  signal?: AbortSignal;
}

export interface PosterWorkflowResult extends GenerationWorkflowResult {
  prompt: PosterPromptBundle;
}

export const executePosterWorkflow = async (input: PosterWorkflowInput): Promise<PosterWorkflowResult> => {
  if (input.engine.provider !== "gemini") {
    throw new GenerationEngineError(
      "海报排版向导仅支持 Gemini 图像引擎",
      "POSTER_PROVIDER_REQUIRED",
      "请先在设置中将图像引擎切换为 Gemini。",
      input.engine.provider
    );
  }
  if (!input.baseImageBase64.trim()) {
    throw new GenerationEngineError(
      "未收到海报参考选区",
      "POSTER_SELECTION_REQUIRED",
      "请先在 Photoshop 中选择需要保留的主体区域。",
      "gemini"
    );
  }
  const prompt = buildPosterPrompt(input.draft);
  const result = await executeGenerationTask(
    input.engine,
    {
      request: {
        prompt: prompt.userPrompt,
        systemPrompt: prompt.systemPrompt,
        aspectRatio: prompt.aspectRatio,
        baseImageBase64: input.baseImageBase64,
        timeoutMs: input.timeoutMs,
        taskId: input.taskId,
        signal: input.signal
      },
      feather: input.feather,
      taskId: input.taskId,
      groupName: "PXD 海报排版",
      emptyImagesMessage: "海报模型未返回可用图像",
      isCurrent: input.isCurrent,
      onRequestStart: input.onRequestStart,
      onRequestSettled: input.onRequestSettled,
      onLayerPlaced: input.onLayerPlaced
    },
    input.adapters
  );
  return { ...result, prompt };
};
