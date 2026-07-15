import {
  GenerationEngineError,
  type GenerationEngine
} from "./generationEngine";
import type {
  CapturedDocumentRegion,
  PartitionPlacementInput,
  PartitionPlacementResult
} from "./photoshop";
import type { GlobalPartitionPlan, GlobalPartitionTile } from "./globalPartition";
import type { NormalizedGlobalPartitionImage } from "./globalPartitionImage";

export interface GlobalPartitionWorkflowAdapters {
  captureRegion: (
    documentId: number,
    tile: GlobalPartitionTile,
    options: { taskId: string }
  ) => Promise<CapturedDocumentRegion>;
  placeImages: (
    documentId: number,
    placements: PartitionPlacementInput[],
    options: {
      taskId: string;
      overlap: number;
      maskContract: number;
      maskFeather: number;
      isCurrent: () => boolean;
      onProgress: (completed: number, total: number) => void | Promise<void>;
    }
  ) => Promise<PartitionPlacementResult>;
  normalizeImage: (
    image: string,
    options: {
      targetWidth: number;
      targetHeight: number;
      retainedBytes: number;
      maxWorkingBytes: number;
      isCurrent: () => boolean;
    }
  ) => Promise<NormalizedGlobalPartitionImage>;
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
  maxWorkingBytes: number;
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

  const tileTaskIds = input.plan.tiles.map((tile) => `${input.taskId}:tile:${tile.index}`);
  let completed = 0;
  const images: string[] = [];
  const placements: PartitionPlacementInput[] = [];
  let retainedBytes = 0;
  let largestPlacementBinaryBytes = 0;
  try {
    for (let index = 0; index < input.plan.tiles.length; index += 1) {
      const tile = input.plan.tiles[index];
      const capture = await input.adapters.captureRegion(input.documentId, tile, {
        taskId: input.taskId
      });
      assertCurrent();
      if (capture.tileId !== tile.id || !capture.dataUrl) {
        throw new Error(`缺少分区 ${tile.id} 的截图`);
      }
      const result = await input.engine.generate({
        prompt: input.prompt,
        baseImageBase64: dataUrlToBase64(capture.dataUrl),
        timeoutMs: input.timeoutMs,
        taskId: tileTaskIds[index]
      });
      capture.dataUrl = "";
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
      const normalized = await input.adapters.normalizeImage(image, {
        targetWidth: tile.targetWidth,
        targetHeight: tile.targetHeight,
        retainedBytes,
        maxWorkingBytes: input.maxWorkingBytes,
        isCurrent: input.isCurrent
      });
      assertCurrent();
      retainedBytes += normalized.base64.length;
      largestPlacementBinaryBytes = Math.max(largestPlacementBinaryBytes, normalized.encodedBytes);
      images.push(normalized.base64);
      placements.push({ tile, dataUrl: normalized.dataUrl });
      completed += 1;
      input.onProgress?.(
        0.05 + 0.65 * (completed / input.plan.tiles.length),
        `已生成 ${completed}/${input.plan.tiles.length} 个分区`
      );
    }
  } catch (error) {
    for (const taskId of tileTaskIds) input.engine.cancel(taskId);
    throw error;
  }
  assertCurrent();
  if (retainedBytes + largestPlacementBinaryBytes * 2 > input.maxWorkingBytes) {
    throw new Error("分区结果贴回所需内存超过 96 MiB 工作内存上限");
  }

  const placement = await input.adapters.placeImages(input.documentId, placements, {
    taskId: input.taskId,
    overlap: input.plan.overlap,
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
