import {
  GenerationEngineError,
  type GenerationEngine
} from "./generationEngine";
import {
  buildAtlasPrompt,
  createMultiRegionAtlasPlan,
  type AtlasRegionCapture,
  type MultiRegionAtlasPlan
} from "./multiRegionAtlas";
import { atlasRetainedBytes, type AtlasImageResult } from "./multiRegionAtlasImage";

export interface MultiRegionAtlasPart {
  regionId: string;
  dataUrl: string;
  width: number;
  height: number;
}

export interface MultiRegionAtlasPlacementResult {
  layerIds: number[];
  groupId: number;
}

export interface MultiRegionAtlasWorkflowAdapters {
  compose: (
    regions: AtlasRegionCapture[],
    plan: MultiRegionAtlasPlan,
    isCurrent: () => boolean
  ) => Promise<AtlasImageResult>;
  normalize: (
    image: string,
    plan: MultiRegionAtlasPlan,
    options: { maxWorkingBytes: number; retainedBytes: number; isCurrent: () => boolean }
  ) => Promise<AtlasImageResult>;
  split: (
    atlas: AtlasImageResult,
    plan: MultiRegionAtlasPlan,
    options: { maxWorkingBytes: number; retainedBytes: number; isCurrent: () => boolean }
  ) => Promise<MultiRegionAtlasPart[]>;
  place: (
    documentId: number,
    regions: AtlasRegionCapture[],
    parts: MultiRegionAtlasPart[],
    options: { taskId: string; isCurrent: () => boolean }
  ) => Promise<MultiRegionAtlasPlacementResult>;
}

export interface MultiRegionAtlasWorkflowInput {
  engine: GenerationEngine;
  regions: AtlasRegionCapture[];
  prompt: string;
  targetMaxEdge: number;
  timeoutMs: number;
  taskId: string;
  maxWorkingBytes: number;
  isCurrent: () => boolean;
  onProgress?: (value: number, message: string) => void;
  adapters: MultiRegionAtlasWorkflowAdapters;
}

export interface MultiRegionAtlasWorkflowResult extends MultiRegionAtlasPlacementResult {
  plan: MultiRegionAtlasPlan;
  atlas: AtlasImageResult;
  resultAtlas: AtlasImageResult;
  parts: MultiRegionAtlasPart[];
}

const staleError = (provider: GenerationEngine["provider"]) => new GenerationEngineError(
  "多区拼接任务已取消，旧结果已忽略",
  "ENGINE_STALE",
  "请重新运行多区拼接。",
  provider
);

export const executeMultiRegionAtlasWorkflow = async (
  input: MultiRegionAtlasWorkflowInput
): Promise<MultiRegionAtlasWorkflowResult> => {
  if (input.engine.provider !== "gemini") {
    throw new Error("多区拼接仅支持 Gemini 图像引擎");
  }
  const assertCurrent = () => {
    if (!input.isCurrent()) throw staleError(input.engine.provider);
  };
  assertCurrent();
  const plan = createMultiRegionAtlasPlan({
    regions: input.regions,
    targetMaxEdge: input.targetMaxEdge,
    maxWorkingBytes: input.maxWorkingBytes
  });
  const documentId = input.regions[0].documentId;
  input.onProgress?.(0.05, "正在合成多区 Atlas");
  const atlas = await input.adapters.compose(input.regions, plan, input.isCurrent);
  assertCurrent();
  const inputAtlasRetainedBytes = atlasRetainedBytes(atlas);
  if (plan.captureWorkingBytes + inputAtlasRetainedBytes > input.maxWorkingBytes) {
    throw new Error("输入 Atlas 的实际字节数超过 96 MiB 工作内存上限");
  }

  input.onProgress?.(0.25, "正在一次处理全部区域");
  const generated = await input.engine.generate({
    prompt: buildAtlasPrompt(input.prompt, plan),
    baseImageBase64: atlas.base64,
    timeoutMs: input.timeoutMs,
    taskId: input.taskId
  });
  assertCurrent();
  const image = generated.images[0];
  if (!image) {
    throw new GenerationEngineError(
      "多区拼接未返回图像",
      "ENGINE_NO_IMAGES",
      "请检查当前 Gemini 图像模型后重试。",
      input.engine.provider
    );
  }

  input.onProgress?.(0.6, "正在校验 Atlas 布局");
  const resultAtlas = await input.adapters.normalize(image, plan, {
    maxWorkingBytes: input.maxWorkingBytes,
    retainedBytes: inputAtlasRetainedBytes,
    isCurrent: input.isCurrent
  });
  assertCurrent();
  const parts = await input.adapters.split(resultAtlas, plan, {
    maxWorkingBytes: input.maxWorkingBytes,
    retainedBytes: inputAtlasRetainedBytes,
    isCurrent: input.isCurrent
  });
  assertCurrent();
  if (parts.length !== input.regions.length || parts.some((part, index) => part.regionId !== input.regions[index].id)) {
    throw new Error("Atlas 拆分结果与选区账本不一致");
  }

  input.onProgress?.(0.8, "正在非破坏贴回 Photoshop");
  const placement = await input.adapters.place(documentId, input.regions, parts, {
    taskId: input.taskId,
    isCurrent: input.isCurrent
  });
  assertCurrent();
  input.onProgress?.(1, "多区拼接完成");
  return { plan, atlas, resultAtlas, parts, ...placement };
};
