import {
  GenerationEngineError,
  type GenerationEngine
} from "./generationEngine";
import type {
  SceneSourceCapture,
  ScenePlacementResult
} from "./photoshop";
import type { ScenePack } from "./scenePacks";

export const DEFAULT_SCENE_MAX_INPUT_BYTES = 32 * 1024 * 1024;

export interface SceneWorkflowAdapters {
  captureSource: (options: {
    taskId: string;
    maxEdge: number;
    includeSelection: boolean;
    preserveSelection: boolean;
    maxInputBytes: number;
  }) => Promise<SceneSourceCapture>;
  placeBackground: (
    capture: SceneSourceCapture,
    dataUrl: string,
    options: {
      taskId: string;
      protectSubject: boolean;
      isCurrent: () => boolean;
      layerName: string;
    }
  ) => Promise<ScenePlacementResult>;
  removePlacement: (
    documentId: number,
    layerId: number,
    options: { taskId: string }
  ) => Promise<void>;
  releaseCapture: (capture: SceneSourceCapture, options: { taskId: string }) => Promise<void>;
}

export interface SceneWorkflowInput {
  engine: GenerationEngine;
  pack: ScenePack;
  prompt: string;
  taskId: string;
  timeoutMs: number;
  targetMaxEdge: number;
  protectSubject: boolean;
  useSelectionReference: boolean;
  maxInputBytes?: number;
  isCurrent: () => boolean;
  onProgress?: (value: number, message: string) => void;
  adapters: SceneWorkflowAdapters;
}

export interface SceneWorkflowResult extends ScenePlacementResult {
  image: string;
  documentId: number;
}

export class SceneWorkflowError extends Error {
  readonly recoveryFailed: boolean;
  readonly causes: unknown[];

  constructor(message: string, causes: unknown[], recoveryFailed: boolean) {
    super(message);
    this.name = "SceneWorkflowError";
    this.causes = causes;
    this.recoveryFailed = recoveryFailed;
  }
}

const stripDataUrl = (value: string) => value.replace(/^data:image\/[^;]+;base64,/i, "").replace(/\s/g, "");

const decodedBytes = (value: string) => {
  const base64 = stripDataUrl(value);
  if (!base64 || !/^[a-z0-9+/]*={0,2}$/i.test(base64) || base64.length % 4 === 1) {
    throw new Error("场景图片不是有效的 base64 数据");
  }
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor(base64.length * 3 / 4) - padding;
};

const staleError = () => new GenerationEngineError(
  "场景生成已取消，旧结果已忽略",
  "ENGINE_STALE",
  "请重新运行场景包。",
  "gemini"
);

const isRecoveryFailure = (error: unknown) => Boolean(
  error && typeof error === "object" && (error as { recoveryFailed?: unknown }).recoveryFailed === true
);

export const executeSceneWorkflow = async (input: SceneWorkflowInput): Promise<SceneWorkflowResult> => {
  if (input.engine.provider !== "gemini") {
    throw new GenerationEngineError(
      "场景包仅支持 Gemini 图像引擎",
      "SCENE_PROVIDER_UNSUPPORTED",
      "请在设置中切换到 Gemini 后重试。",
      input.engine.provider
    );
  }
  const assertCurrent = () => {
    if (!input.isCurrent()) throw staleError();
  };
  const maxInputBytes = Math.max(1024 * 1024, input.maxInputBytes ?? DEFAULT_SCENE_MAX_INPUT_BYTES);
  assertCurrent();
  input.onProgress?.(0.05, "正在读取场景画布");
  let capture: SceneSourceCapture;
  try {
    capture = await input.adapters.captureSource({
      taskId: input.taskId,
      maxEdge: input.targetMaxEdge,
      includeSelection: input.useSelectionReference,
      preserveSelection: input.protectSubject,
      maxInputBytes
    });
  } catch (error) {
    if (isRecoveryFailure(error)) {
      throw new SceneWorkflowError(
        error instanceof Error ? error.message : String(error),
        [error],
        true
      );
    }
    throw error;
  }
  let placement: ScenePlacementResult | null = null;
  let image = "";
  let failure: unknown = null;
  try {
    assertCurrent();
    if ((input.protectSubject || input.useSelectionReference) && !capture.selectionBounds) {
      throw new Error("当前文档没有可用的主体选区");
    }
    const base64 = stripDataUrl(capture.baseImageDataUrl);
    const reference = capture.referenceImageDataUrl
      ? stripDataUrl(capture.referenceImageDataUrl)
      : null;
    const inputBytes = decodedBytes(base64) + (reference ? decodedBytes(reference) : 0);
    if (inputBytes > maxInputBytes) throw new Error("场景画布与人物参考图超过 32 MiB 输入上限");
    input.onProgress?.(0.2, "正在生成新场景");
    const result = await input.engine.generate({
      prompt: input.prompt,
      baseImageBase64: base64,
      refImagesBase64: reference ? [reference] : undefined,
      timeoutMs: input.timeoutMs,
      taskId: input.taskId
    });
    assertCurrent();
    image = result.images[0] ?? "";
    if (!image) {
      throw new GenerationEngineError(
        "场景模型未返回图片",
        "ENGINE_NO_IMAGES",
        "请调整场景选项后重试。",
        "gemini"
      );
    }
    input.onProgress?.(0.78, "正在回贴场景背景");
    placement = await input.adapters.placeBackground(
      capture,
      `data:image/png;base64,${stripDataUrl(image)}`,
      {
        taskId: input.taskId,
        protectSubject: input.protectSubject,
        isCurrent: input.isCurrent,
        layerName: `PXD 场景 · ${input.pack.name}`
      }
    );
    assertCurrent();
    input.onProgress?.(1, "场景替换完成");
  } catch (error) {
    input.engine.cancel(input.taskId);
    failure = error;
  }

  const recoveryErrors: unknown[] = [];
  try {
    await input.adapters.releaseCapture(capture, { taskId: input.taskId });
  } catch (error) {
    recoveryErrors.push(error);
  }
  if (failure || recoveryErrors.length) {
    if (placement) {
      try {
        await input.adapters.removePlacement(capture.documentId, placement.layerId, { taskId: input.taskId });
      } catch (error) {
        recoveryErrors.push(error);
      }
    }
    if (recoveryErrors.length || isRecoveryFailure(failure)) {
      const details = [failure, ...recoveryErrors]
        .filter(Boolean)
        .map((error) => error instanceof Error ? error.message : String(error))
        .join("；");
      throw new SceneWorkflowError(`场景操作恢复失败：${details}`, [failure, ...recoveryErrors], true);
    }
    throw failure;
  }
  return { ...(placement as ScenePlacementResult), image: stripDataUrl(image), documentId: capture.documentId };
};
