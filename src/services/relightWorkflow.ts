import { GenerationEngineError, type GenerationEngine } from "./generationEngine";
import { buildRelightPrompt, type RelightLight } from "./relight";
import type { RelightSource } from "./photoshop";

export type RelightPhase = "preparing" | "generating" | "applying";

export interface RelightWorkflowTask {
  lights: RelightLight[];
  prompt: string;
  taskId: string;
  timeoutMs: number;
  signal: AbortSignal;
  isCurrent: () => boolean;
  onPhase?: (phase: RelightPhase) => void;
}

export interface RelightWorkflowAdapters {
  capture: (taskId: string) => Promise<RelightSource>;
  validate: (source: RelightSource, taskId: string) => Promise<void>;
  apply: (
    source: RelightSource,
    dataUrl: string,
    taskId: string,
    isCurrent: () => boolean
  ) => Promise<{ layerId: number }>;
  rollback: (source: RelightSource, layerId: number, taskId: string) => Promise<void>;
  restore: (source: RelightSource, taskId: string) => Promise<void>;
}

export interface RelightWorkflowResult {
  image: string;
  layerId: number;
  prompt: string;
  source: RelightSource;
}

const stripDataUrl = (value: string) => value.replace(/^data:image\/[^;]+;base64,/i, "");
const toDataUrl = (value: string) => value.startsWith("data:") ? value : `data:image/png;base64,${value}`;

const assertCurrent = (engine: GenerationEngine, task: RelightWorkflowTask) => {
  if (!task.isCurrent() || task.signal.aborted) {
    throw new GenerationEngineError(
      "可视化打光已取消",
      "CANCELLED",
      "请重新发起可视化打光。",
      engine.provider
    );
  }
};

export const executeRelightWorkflow = async (
  engine: GenerationEngine,
  task: RelightWorkflowTask,
  adapters: RelightWorkflowAdapters
): Promise<RelightWorkflowResult> => {
  if (engine.provider !== "gemini") {
    throw new GenerationEngineError(
      "可视化打光需要闭源图像引擎",
      "RELIGHT_ENGINE_REQUIRED",
      "请在设置中切换到 Gemini 图像模型。",
      engine.provider
    );
  }
  if (!task.lights.length) throw new Error("请至少添加一盏灯");
  let source: RelightSource | null = null;
  let placedLayerId = 0;
  let workflowError: unknown;
  let workflowResult: RelightWorkflowResult | null = null;
  const prompt = buildRelightPrompt(task.lights, task.prompt);
  try {
    task.onPhase?.("preparing");
    source = await adapters.capture(task.taskId);
    assertCurrent(engine, task);
    task.onPhase?.("generating");
    const generated = await engine.generate({
      prompt,
      baseImageBase64: stripDataUrl(source.dataUrl),
      timeoutMs: task.timeoutMs,
      taskId: task.taskId,
      signal: task.signal
    });
    assertCurrent(engine, task);
    const image = generated.images[0];
    if (!image) throw new Error("可视化打光未返回图像");
    await adapters.validate(source, task.taskId);
    assertCurrent(engine, task);
    task.onPhase?.("applying");
    const placed = await adapters.apply(source, toDataUrl(image), task.taskId, () =>
      task.isCurrent() && !task.signal.aborted
    );
    placedLayerId = placed.layerId;
    assertCurrent(engine, task);
    workflowResult = { image, layerId: placedLayerId, prompt, source };
  } catch (error) {
    workflowError = error;
    if (source && placedLayerId > 0) {
      try {
        await adapters.rollback(source, placedLayerId, task.taskId);
        placedLayerId = 0;
      } catch (rollbackError) {
        workflowError = new Error(
          `${error instanceof Error ? error.message : "可视化打光失败"}；回滚失败：` +
          `${rollbackError instanceof Error ? rollbackError.message : "未知错误"}`
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
              `${workflowError instanceof Error ? workflowError.message : "可视化打光失败"}；` +
              `恢复 Photoshop 上下文失败：${restoreError instanceof Error ? restoreError.message : "未知错误"}`
            )
          : restoreError;
        if (placedLayerId > 0) {
          try {
            await adapters.rollback(source, placedLayerId, task.taskId);
            placedLayerId = 0;
            workflowResult = null;
          } catch (rollbackError) {
            workflowError = new Error(
              `${workflowError instanceof Error ? workflowError.message : "可视化打光失败"}；` +
              `回滚失败：${rollbackError instanceof Error ? rollbackError.message : "未知错误"}`
            );
          }
        }
      }
    }
  }
  if (workflowError) throw workflowError;
  if (!workflowResult) throw new Error("可视化打光未完成");
  return workflowResult;
};
