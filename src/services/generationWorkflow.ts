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
    options: { feather: number; taskId?: string }
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
  isCurrent?: () => boolean;
}

export type GenerationReturnTask = Pick<
  GenerationWorkflowTask,
  "feather" | "taskId" | "groupName" | "prepare" | "isCurrent"
>;

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

const createCurrentAssertion = (
  engine: GenerationEngine,
  isCurrent?: () => boolean
) => () => {
  if (isCurrent && !isCurrent()) {
    throw new GenerationEngineError(
      "生成引擎已切换，旧任务结果已忽略",
      "ENGINE_STALE",
      "请使用当前引擎重新生成。",
      engine.provider
    );
  }
};

const placeGeneratedImages = async (
  images: string[],
  task: GenerationReturnTask,
  adapters: GenerationWorkflowAdapters,
  assertCurrent: () => void
): Promise<GenerationWorkflowResult> => {
  const placedLayerIds: number[] = [];
  for (let index = 0; index < images.length; index += 1) {
    assertCurrent();
    const info = await adapters.placeImage(toDataUrl(images[index]), index + 1, {
      feather: task.feather,
      taskId: task.taskId
    });
    assertCurrent();
    const layerId = extractLayerId(info);
    if (layerId) placedLayerIds.push(layerId);
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
  return { images, placedLayerIds };
};

export const returnGenerationImages = async (
  engine: GenerationEngine,
  images: string[],
  task: GenerationReturnTask,
  adapters: GenerationWorkflowAdapters
): Promise<GenerationWorkflowResult> => {
  const assertCurrent = createCurrentAssertion(engine, task.isCurrent);
  assertCurrent();
  await task.prepare?.();
  assertCurrent();
  if (!images.length) {
    throw new GenerationEngineError(
      "任务未返回图像",
      "ENGINE_NO_IMAGES",
      "请检查当前引擎是否支持图像输出后重试。",
      engine.provider
    );
  }
  return await placeGeneratedImages(images, task, adapters, assertCurrent);
};

export const executeGenerationTask = async (
  engine: GenerationEngine,
  task: GenerationWorkflowTask,
  adapters: GenerationWorkflowAdapters
): Promise<GenerationWorkflowResult> => {
  const assertCurrent = createCurrentAssertion(engine, task.isCurrent);
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

  return await placeGeneratedImages(result.images, task, adapters, assertCurrent);
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
