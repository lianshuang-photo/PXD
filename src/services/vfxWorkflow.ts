import { GenerationEngineError, type GenerationEngine } from "./generationEngine";
import type { VfxSource } from "./photoshop";
import { buildVfxPrompt, type VfxConfig } from "./vfx";

export type VfxPhase = "preparing" | "generating" | "applying";

export interface VfxWorkflowTask {
  config: VfxConfig;
  prompt: string;
  taskId: string;
  timeoutMs: number;
  signal: AbortSignal;
  isCurrent: () => boolean;
  onPhase?: (phase: VfxPhase) => void;
}

export interface VfxWorkflowAdapters {
  capture: (taskId: string) => Promise<VfxSource>;
  validate: (source: VfxSource, taskId: string) => Promise<void>;
  apply: (
    source: VfxSource,
    dataUrl: string,
    config: VfxConfig,
    taskId: string,
    isCurrent: () => boolean
  ) => Promise<{ layerId: number }>;
  rollback: (source: VfxSource, layerId: number, taskId: string) => Promise<void>;
  restore: (source: VfxSource, taskId: string) => Promise<void>;
}

export interface VfxWorkflowResult {
  image: string;
  layerId: number;
  prompt: string;
  source: VfxSource;
}

const stripDataUrl = (value: string) => value.replace(/^data:image\/[^;]+;base64,/i, "");
const toDataUrl = (value: string) => value.startsWith("data:") ? value : `data:image/png;base64,${value}`;

const assertCurrent = (engine: GenerationEngine, task: VfxWorkflowTask) => {
  if (!task.isCurrent() || task.signal.aborted) {
    throw new GenerationEngineError(
      "VFX 特效生成已取消",
      "CANCELLED",
      "请重新发起特效生成。",
      engine.provider
    );
  }
};

export const executeVfxWorkflow = async (
  engine: GenerationEngine,
  task: VfxWorkflowTask,
  adapters: VfxWorkflowAdapters
): Promise<VfxWorkflowResult> => {
  if (engine.provider !== "gemini") {
    throw new GenerationEngineError(
      "VFX 特效生成需要闭源图像引擎",
      "VFX_ENGINE_REQUIRED",
      "请在设置中切换到 Gemini 图像模型。",
      engine.provider
    );
  }
  let source: VfxSource | null = null;
  let placedLayerId = 0;
  let workflowError: unknown;
  let workflowResult: VfxWorkflowResult | null = null;
  const prompt = buildVfxPrompt(task.config, task.prompt);
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
    if (!image) throw new Error("VFX 特效未返回图像");
    await adapters.validate(source, task.taskId);
    assertCurrent(engine, task);
    task.onPhase?.("applying");
    const placed = await adapters.apply(source, toDataUrl(image), task.config, task.taskId, () =>
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
          `${error instanceof Error ? error.message : "VFX 特效生成失败"}；回滚失败：` +
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
              `${workflowError instanceof Error ? workflowError.message : "VFX 特效生成失败"}；` +
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
              `${workflowError instanceof Error ? workflowError.message : "VFX 特效生成失败"}；` +
              `回滚失败：${rollbackError instanceof Error ? rollbackError.message : "未知错误"}`
            );
          }
        }
      }
    }
  }
  if (workflowError) throw workflowError;
  if (!workflowResult) throw new Error("VFX 特效生成未完成");
  return workflowResult;
};
