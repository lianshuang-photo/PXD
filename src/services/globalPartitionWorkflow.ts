import {
  GenerationEngineError,
  type GenerationEngine
} from "./generationEngine";
import type {
  CapturedDocumentRegion,
  PartitionPlacementInput,
  PartitionPlacementResult
} from "./photoshop";
import type { GlobalPartitionPlan } from "./globalPartition";

export interface GlobalPartitionWorkflowAdapters {
  captureRegions: (
    documentId: number,
    plan: GlobalPartitionPlan,
    options: { taskId: string }
  ) => Promise<CapturedDocumentRegion[]>;
  placeImages: (
    documentId: number,
    placements: PartitionPlacementInput[],
    options: {
      taskId: string;
      maskContract: number;
      maskFeather: number;
      isCurrent: () => boolean;
      onProgress: (completed: number, total: number) => void | Promise<void>;
    }
  ) => Promise<PartitionPlacementResult>;
}

export interface GlobalPartitionWorkflowInput {
  engine: GenerationEngine;
  documentId: number;
  plan: GlobalPartitionPlan;
  prompt: string;
  timeoutMs: number;
  taskId: string;
  maskContract: number;
  maskFeather: number;
  isCurrent: () => boolean;
  onProgress?: (value: number, message: string) => void;
  adapters: GlobalPartitionWorkflowAdapters;
}

export interface GlobalPartitionWorkflowResult extends PartitionPlacementResult {
  images: string[];
}

const staleError = (provider: GenerationEngine["provider"]) => new GenerationEngineError(
  "大图分区任务已取消，旧结果已忽略",
  "ENGINE_STALE",
  "请重新运行大图分区。",
  provider
);

const dataUrlToBase64 = (value: string) => value.includes(",")
  ? value.split(",").pop() ?? value
  : value;

export const executeGlobalPartitionWorkflow = async (
  input: GlobalPartitionWorkflowInput
): Promise<GlobalPartitionWorkflowResult> => {
  const assertCurrent = () => {
    if (!input.isCurrent()) throw staleError(input.engine.provider);
  };
  assertCurrent();
  input.onProgress?.(0.05, "正在读取大图分区");
  const captures = await input.adapters.captureRegions(input.documentId, input.plan, {
    taskId: input.taskId
  });
  assertCurrent();
  const capturesById = new Map(captures.map((capture) => [capture.tileId, capture]));
  if (capturesById.size !== input.plan.tiles.length) {
    throw new Error("Photoshop 未返回完整的分区截图");
  }
  input.onProgress?.(0.2, "分区截图完成");

  const tileTaskIds = input.plan.tiles.map((tile) => `${input.taskId}:tile:${tile.index}`);
  let completed = 0;
  let images: string[];
  try {
    images = await Promise.all(input.plan.tiles.map(async (tile, index) => {
      const capture = capturesById.get(tile.id);
      if (!capture?.dataUrl) throw new Error(`缺少分区 ${tile.id} 的截图`);
      const result = await input.engine.generate({
        prompt: input.prompt,
        baseImageBase64: dataUrlToBase64(capture.dataUrl),
        timeoutMs: input.timeoutMs,
        taskId: tileTaskIds[index]
      });
      assertCurrent();
      const image = result.images[0];
      if (!image) {
        throw new GenerationEngineError(
          `分区 ${index + 1} 未返回图像`,
          "ENGINE_NO_IMAGES",
          "请检查当前闭源图像模型后重试。",
          input.engine.provider
        );
      }
      completed += 1;
      input.onProgress?.(
        0.2 + 0.5 * (completed / input.plan.tiles.length),
        `已生成 ${completed}/${input.plan.tiles.length} 个分区`
      );
      return image;
    }));
  } catch (error) {
    for (const taskId of tileTaskIds) input.engine.cancel(taskId);
    throw error;
  }
  assertCurrent();

  const placements = input.plan.tiles.map((tile, index) => ({
    tile,
    dataUrl: `data:image/png;base64,${images[index]}`
  }));
  const placement = await input.adapters.placeImages(input.documentId, placements, {
    taskId: input.taskId,
    maskContract: input.maskContract,
    maskFeather: input.maskFeather,
    isCurrent: input.isCurrent,
    onProgress: (placed, total) => {
      input.onProgress?.(0.7 + 0.25 * (placed / total), `已贴回 ${placed}/${total} 个分区`);
    }
  });
  assertCurrent();
  input.onProgress?.(1, "大图分区处理完成");
  return { ...placement, images };
};
