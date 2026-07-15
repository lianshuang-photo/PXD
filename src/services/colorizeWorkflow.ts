import {
  GenerationEngineError,
  type GenerationEngine
} from "./generationEngine";
import type { ColorizeSource } from "./photoshop";

export type ColorizePhase = "preparing" | "generating" | "applying";

export interface ColorizeWorkflowTask {
  prompt: string;
  taskId: string;
  timeoutMs: number;
  signal: AbortSignal;
  isCurrent: () => boolean;
  onPhase?: (phase: ColorizePhase) => void;
}

export interface ColorizeWorkflowAdapters {
  prepare: (taskId: string) => Promise<ColorizeSource>;
  apply: (
    source: ColorizeSource,
    resultDataUrl: string,
    taskId: string,
    isCurrent: () => boolean
  ) => Promise<{ layerId: number }>;
  rollback: (source: ColorizeSource, layerId: number, taskId: string) => Promise<void>;
  restore: (source: ColorizeSource, taskId: string) => Promise<void>;
}

export interface ColorizeWorkflowResult {
  image: string;
  layerId: number;
  source: ColorizeSource;
}

const stripDataUrl = (value: string) => value.replace(/^data:image\/[^;]+;base64,/i, "");
const toDataUrl = (value: string) => value.startsWith("data:") ? value : `data:image/png;base64,${value}`;

const assertCurrent = (engine: GenerationEngine, task: ColorizeWorkflowTask) => {
  if (!task.isCurrent() || task.signal.aborted) {
    throw new GenerationEngineError(
      "智能调色已取消",
      "CANCELLED",
      "请重新发起智能调色。",
      engine.provider
    );
  }
};

export const executeColorizeWorkflow = async (
  engine: GenerationEngine,
  task: ColorizeWorkflowTask,
  adapters: ColorizeWorkflowAdapters
): Promise<ColorizeWorkflowResult> => {
  if (engine.provider !== "gemini") {
    throw new GenerationEngineError(
      "AI 智能调色需要闭源图像引擎",
      "COLORIZE_ENGINE_REQUIRED",
      "请在设置中切换到 Gemini 图像模型。",
      engine.provider
    );
  }
  let source: ColorizeSource | null = null;
  let placedLayerId = 0;
  let workflowError: unknown;
  let workflowResult: ColorizeWorkflowResult | null = null;
  try {
    task.onPhase?.("preparing");
    source = await adapters.prepare(task.taskId);
    assertCurrent(engine, task);
    task.onPhase?.("generating");
    const instruction = [
      "Recolor this grayscale image according to the requested color direction.",
      "Preserve composition, geometry, texture, lighting detail, and all object boundaries exactly.",
      "Change color only. Do not add, remove, reshape, retouch, or move anything.",
      task.prompt.trim() || "Apply natural, coherent colors with realistic skin tones and balanced contrast."
    ].join("\n");
    const generated = await engine.generate({
      prompt: instruction,
      baseImageBase64: stripDataUrl(source.dataUrl),
      timeoutMs: task.timeoutMs,
      taskId: task.taskId,
      signal: task.signal
    });
    assertCurrent(engine, task);
    const image = generated.images[0];
    if (!image) {
      throw new GenerationEngineError(
        "智能调色未返回图像",
        "COLORIZE_NO_IMAGE",
        "请调整调色提示词后重试。",
        engine.provider
      );
    }
    task.onPhase?.("applying");
    const placement = await adapters.apply(
      source,
      toDataUrl(image),
      task.taskId,
      () => task.isCurrent() && !task.signal.aborted
    );
    placedLayerId = placement.layerId;
    assertCurrent(engine, task);
    workflowResult = { image, layerId: placedLayerId, source };
  } catch (error) {
    workflowError = error;
    if (source && placedLayerId) {
      try {
        await adapters.rollback(source, placedLayerId, task.taskId);
        placedLayerId = 0;
      } catch (rollbackError) {
        workflowError = new Error(
          `${error instanceof Error ? error.message : "智能调色失败"}；回滚失败：${rollbackError instanceof Error ? rollbackError.message : "未知错误"}`
        );
      }
    }
  } finally {
    if (source) {
      try {
        await adapters.restore(source, task.taskId);
      } catch (restoreError) {
        workflowError = workflowError
          ? new Error(
              `${workflowError instanceof Error ? workflowError.message : "智能调色失败"}；恢复 Photoshop 上下文失败：${restoreError instanceof Error ? restoreError.message : "未知错误"}`
            )
          : restoreError;
      }
    }
  }
  if (workflowError) throw workflowError;
  if (!workflowResult) throw new Error("智能调色未完成");
  return workflowResult;
};
