import {
  GenerationEngineError,
  type EngineGenerateParams,
  type EngineResult,
  type GenerationEngine
} from "./generationEngine";

export interface GenerationWorkflowAdapters {
  placeImage: (
    dataUrl: string,
    index: number,
    options: { feather: number }
  ) => Promise<unknown>;
  groupLayers: (layerIds: number[], groupName?: string) => Promise<unknown>;
  moveActiveLayerToTop: () => Promise<unknown>;
}

export interface GenerationWorkflowTask {
  request: EngineGenerateParams;
  feather: number;
  groupName?: string;
  emptyImagesMessage: string;
  prepare?: () => Promise<void>;
  onRequestStart?: () => void | Promise<void>;
  onRequestSettled?: () => void | Promise<void>;
  isCurrent?: () => boolean;
}

export interface GenerationWorkflowResult extends EngineResult {
  placedLayerIds: number[];
}

const toDataUrl = (base64: string) => `data:image/png;base64,${base64}`;

const extractLayerId = (info: unknown): number | null => {
  if (!info || typeof info !== "object") return null;
  const record = info as Record<string, unknown>;
  const candidate =
    record.layerID ??
    record.layerId ??
    record.targetLayerID ??
    record.targetLayerId ??
    record.ID ??
    record.id ??
    0;
  const numeric = Number(candidate);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
};

export const executeGenerationTask = async (
  engine: GenerationEngine,
  task: GenerationWorkflowTask,
  adapters: GenerationWorkflowAdapters
): Promise<GenerationWorkflowResult> => {
  const assertCurrent = () => {
    if (task.isCurrent && !task.isCurrent()) {
      throw new GenerationEngineError(
        "生成引擎已切换，旧任务结果已忽略",
        "ENGINE_STALE",
        "请使用当前引擎重新生成。",
        engine.provider
      );
    }
  };
  assertCurrent();
  await task.prepare?.();
  assertCurrent();
  await task.onRequestStart?.();
  let result: EngineResult;
  try {
    result = await engine.generate(task.request);
  } finally {
    await task.onRequestSettled?.();
  }
  assertCurrent();
  if (!result.images.length) {
    throw new GenerationEngineError(
      task.emptyImagesMessage,
      "ENGINE_NO_IMAGES",
      "请检查当前引擎是否支持图像输出后重试。",
      engine.provider
    );
  }

  const placedLayerIds: number[] = [];
  for (let index = 0; index < result.images.length; index += 1) {
    assertCurrent();
    const info = await adapters.placeImage(toDataUrl(result.images[index]), index + 1, {
      feather: task.feather
    });
    assertCurrent();
    const layerId = extractLayerId(info);
    if (layerId) placedLayerIds.push(layerId);
  }
  if (placedLayerIds.length > 1) {
    assertCurrent();
    await adapters.groupLayers(placedLayerIds, task.groupName);
    assertCurrent();
  }
  assertCurrent();
  await adapters.moveActiveLayerToTop();
  assertCurrent();
  return { ...result, placedLayerIds };
};

export const executeGenerationBatch = async (
  engine: GenerationEngine,
  tasks: GenerationWorkflowTask[],
  adapters: GenerationWorkflowAdapters
): Promise<GenerationWorkflowResult[]> => {
  const results: GenerationWorkflowResult[] = [];
  for (const task of tasks) {
    results.push(await executeGenerationTask(engine, task, adapters));
  }
  return results;
};
