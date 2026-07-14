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
    options: {
      feather: number;
      taskId?: string;
      onLayerPlaced?: (layerId: number) => void | Promise<void>;
    }
  ) => Promise<unknown>;
  groupLayers: (
    layerIds: number[],
    groupName: string | undefined,
    options: { taskId?: string }
  ) => Promise<number | null>;
  moveActiveLayerToTop: (options: { layerId: number; taskId?: string }) => Promise<unknown>;
}

export interface GenerationWorkflowTask {
  request: EngineGenerateParams;
  feather: number;
  taskId?: string;
  groupName?: string;
  emptyImagesMessage: string;
  prepare?: () => Promise<void>;
  onRequestStart?: () => void | Promise<void>;
  onRequestSettled?: () => void | Promise<void>;
  onLayerPlaced?: (layerId: number) => void | Promise<void>;
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

const extractPartialLayerId = (error: unknown): number | null => {
  if (!error || typeof error !== "object") return null;
  const id = Number((error as { placedLayerId?: unknown }).placedLayerId);
  return Number.isInteger(id) && id > 0 ? id : null;
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
  const reportLayerPlaced = async (layerId: number) => {
    if (placedLayerIds.includes(layerId)) return;
    placedLayerIds.push(layerId);
    await task.onLayerPlaced?.(layerId);
  };
  for (let index = 0; index < result.images.length; index += 1) {
    assertCurrent();
    let info: unknown;
    try {
      info = await adapters.placeImage(toDataUrl(result.images[index]), index + 1, {
        feather: task.feather,
        taskId: task.taskId,
        onLayerPlaced: reportLayerPlaced
      });
    } catch (error) {
      const partialLayerId = extractPartialLayerId(error);
      if (partialLayerId) await reportLayerPlaced(partialLayerId);
      throw error;
    }
    const layerId = extractLayerId(info);
    if (layerId) await reportLayerPlaced(layerId);
    assertCurrent();
  }
  let topLayerId: number | undefined = placedLayerIds[placedLayerIds.length - 1];
  if (placedLayerIds.length > 1) {
    assertCurrent();
    const groupId = await adapters.groupLayers(placedLayerIds, task.groupName, {
      taskId: task.taskId
    });
    topLayerId = groupId ?? topLayerId;
    assertCurrent();
  }
  if (topLayerId) {
    assertCurrent();
    await adapters.moveActiveLayerToTop({ layerId: topLayerId, taskId: task.taskId });
  }
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
