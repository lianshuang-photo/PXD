import { GenerationEngineError, type GenerationEngine } from "./generationEngine";
import type { GeneratedDocumentSession, SelectionBounds } from "./photoshop";

export type TiledUpscaleEdgeMode = "anchor" | "partial";

export interface TiledUpscaleConfig {
  scale: 2 | 4;
  tileSize: number;
  overlap: number;
  feather: number;
  edgeMode: TiledUpscaleEdgeMode;
  prompt: string;
}

export interface TiledUpscaleTile {
  id: string;
  row: number;
  column: number;
  source: SelectionBounds;
  output: SelectionBounds;
  incomingOverlap: { left: number; top: number };
}

export interface TiledUpscalePlan {
  width: number;
  height: number;
  outputWidth: number;
  outputHeight: number;
  rows: number;
  columns: number;
  estimatedWorkingBytes: number;
  tiles: TiledUpscaleTile[];
}

export interface TiledUpscaleSource {
  documentId: number;
  bounds: SelectionBounds;
  width: number;
  height: number;
}

export interface TiledUpscaleProgress {
  completed: number;
  total: number;
  tile: TiledUpscaleTile;
  phase: "reading" | "enhancing" | "blending" | "placing";
}

export interface TiledUpscaleAdapters {
  readTile: (documentId: number, bounds: SelectionBounds, taskId: string) => Promise<string>;
  enhanceTile: (
    engine: GenerationEngine,
    dataUrl: string,
    tile: TiledUpscaleTile,
    config: TiledUpscaleConfig,
    taskId: string
  ) => Promise<string>;
  featherTile: (
    dataUrl: string,
    options: {
      left: number;
      top: number;
      outputWidth: number;
      outputHeight: number;
      isCurrent: () => boolean;
    }
  ) => Promise<string>;
  createOutput: (
    width: number,
    height: number,
    name: string,
    taskId: string
  ) => Promise<GeneratedDocumentSession>;
  placeTile: (
    dataUrl: string,
    bounds: SelectionBounds,
    index: number,
    documentId: number,
    taskId: string
  ) => Promise<unknown>;
  finalize: (layerIds: number[], documentId: number, taskId: string) => Promise<void>;
  rollback: (session: GeneratedDocumentSession, taskId: string) => Promise<void>;
}

export interface ExecuteTiledUpscaleInput {
  engine: GenerationEngine;
  source: TiledUpscaleSource;
  config: TiledUpscaleConfig;
  taskId: string;
  adapters: TiledUpscaleAdapters;
  isCurrent: () => boolean;
  onProgress?: (progress: TiledUpscaleProgress) => void;
}

export interface TiledUpscaleResult {
  session: GeneratedDocumentSession;
  plan: TiledUpscalePlan;
  layerIds: number[];
}

export class TiledUpscaleRollbackError extends Error {
  readonly originalError: unknown;
  readonly rollbackError: unknown;

  constructor(originalError: unknown, rollbackError: unknown) {
    const primary = originalError instanceof Error ? originalError.message : "分块放大失败";
    const cleanup = rollbackError instanceof Error ? rollbackError.message : "恢复失败";
    super(`${primary}；输出文档恢复失败：${cleanup}`);
    this.name = "TiledUpscaleRollbackError";
    this.originalError = originalError;
    this.rollbackError = rollbackError;
  }
}

const MAX_TILES = 64;
const MAX_OUTPUT_SIDE = 32_768;
const MAX_WORKING_SIDE = 4_096;
const MAX_ESTIMATED_WORKING_BYTES = 96 * 1024 * 1024;
const RGBA_BYTES_PER_PIXEL = 4;

const estimateBase64Bytes = (binaryBytes: number) => Math.ceil(binaryBytes / 3) * 4;

const estimateTileWorkingBytes = (tileSize: number, scale: number) => {
  const sourcePixelBytes = tileSize * tileSize * RGBA_BYTES_PER_PIXEL;
  const outputSide = tileSize * scale;
  const outputPixelBytes = outputSide * outputSide * RGBA_BYTES_PER_PIXEL;
  const sourceBase64Bytes = estimateBase64Bytes(sourcePixelBytes);
  const outputBase64Bytes = estimateBase64Bytes(outputPixelBytes);

  const enhancementPeak = sourcePixelBytes + sourceBase64Bytes + outputBase64Bytes;
  const featherPeak = outputPixelBytes * 3 + outputBase64Bytes * 2;
  const placementPeak = outputPixelBytes * 2 + outputBase64Bytes;
  return Math.max(enhancementPeak, featherPeak, placementPeak);
};

const axisStarts = (
  length: number,
  tileSize: number,
  overlap: number,
  feather: number,
  edgeMode: TiledUpscaleEdgeMode
) => {
  if (length <= tileSize) return [0];
  const stride = tileSize - overlap;
  const starts: number[] = [];
  for (let start = 0; start < length; start += stride) {
    starts.push(start);
    if (start + tileSize >= length) break;
  }
  if (edgeMode === "anchor") {
    const anchored = length - tileSize;
    starts[starts.length - 1] = anchored;
    const minimumRemainingOverlap = Math.min(overlap, Math.max(1, feather));
    if (
      starts.length >= 3 &&
      starts[starts.length - 1] - starts[starts.length - 2] < tileSize / 2 &&
      starts[starts.length - 3] + tileSize - starts[starts.length - 1] >= minimumRemainingOverlap
    ) {
      starts.splice(starts.length - 2, 1);
    }
  }
  return Array.from(new Set(starts));
};

const validateConfig = (width: number, height: number, config: TiledUpscaleConfig) => {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error("分块放大源尺寸无效");
  }
  if (![2, 4].includes(config.scale)) throw new Error("目标倍率仅支持 2x 或 4x");
  if (!Number.isInteger(config.tileSize) || config.tileSize < 256 || config.tileSize > 2048) {
    throw new Error("瓦片大小必须在 256 到 2048 像素之间");
  }
  if (!Number.isInteger(config.overlap) || config.overlap < 0 || config.overlap >= config.tileSize) {
    throw new Error("重叠量必须小于瓦片大小");
  }
  if (!Number.isInteger(config.feather) || config.feather < 0 || config.feather > config.overlap) {
    throw new Error("羽化量必须介于 0 和重叠量之间");
  }
  if (width * config.scale > MAX_OUTPUT_SIDE || height * config.scale > MAX_OUTPUT_SIDE) {
    throw new Error("输出边长超过 Photoshop 安全上限 32768 像素");
  }
  if (config.tileSize * config.scale > MAX_WORKING_SIDE) {
    throw new Error("当前瓦片与倍率组合的工作边长超过 4096 像素");
  }
};

export const buildTiledUpscalePlan = (
  width: number,
  height: number,
  config: TiledUpscaleConfig
): TiledUpscalePlan => {
  validateConfig(width, height, config);
  const xs = axisStarts(width, config.tileSize, config.overlap, config.feather, config.edgeMode);
  const ys = axisStarts(height, config.tileSize, config.overlap, config.feather, config.edgeMode);
  if (xs.length * ys.length > MAX_TILES) {
    throw new Error(`瓦片数量超过安全上限 ${MAX_TILES}，请增大瓦片或减小选区`);
  }
  const tiles: TiledUpscaleTile[] = [];
  for (let row = 0; row < ys.length; row += 1) {
    for (let column = 0; column < xs.length; column += 1) {
      const x = xs[column];
      const y = ys[row];
      const tileWidth = Math.min(config.tileSize, width - x);
      const tileHeight = Math.min(config.tileSize, height - y);
      const previousX = column > 0 ? xs[column - 1] : null;
      const previousY = row > 0 ? ys[row - 1] : null;
      const leftOverlap = previousX === null
        ? 0
        : Math.max(0, previousX + Math.min(config.tileSize, width - previousX) - x);
      const topOverlap = previousY === null
        ? 0
        : Math.max(0, previousY + Math.min(config.tileSize, height - previousY) - y);
      tiles.push({
        id: `tile-${row}-${column}`,
        row,
        column,
        source: { left: x, top: y, right: x + tileWidth, bottom: y + tileHeight },
        output: {
          left: x * config.scale,
          top: y * config.scale,
          right: (x + tileWidth) * config.scale,
          bottom: (y + tileHeight) * config.scale
        },
        incomingOverlap: {
          left: Math.min(config.feather, leftOverlap) * config.scale,
          top: Math.min(config.feather, topOverlap) * config.scale
        }
      });
    }
  }
  const estimatedWorkingBytes = estimateTileWorkingBytes(config.tileSize, config.scale);
  if (estimatedWorkingBytes > MAX_ESTIMATED_WORKING_BYTES) {
    throw new Error("单瓦片预计峰值内存超过 96 MiB，请减小瓦片或倍率");
  }
  return {
    width,
    height,
    outputWidth: width * config.scale,
    outputHeight: height * config.scale,
    rows: ys.length,
    columns: xs.length,
    estimatedWorkingBytes,
    tiles
  };
};

export const incomingFeatherAlpha = (
  x: number,
  y: number,
  width: number,
  height: number,
  left: number,
  top: number
) => {
  if (width <= 0 || height <= 0) return 0;
  const raisedCosine = (position: number, distance: number) => {
    if (distance <= 0 || position >= distance) return 1;
    if (position <= 0) return 0;
    return 0.5 - 0.5 * Math.cos(Math.PI * position / distance);
  };
  return Math.min(1, Math.max(0, raisedCosine(x, left) * raisedCosine(y, top)));
};

const extractLayerId = (value: unknown) => {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = Number(record.layerID ?? record.layerId ?? record.ID ?? record.id);
  return Number.isInteger(id) && id > 0 ? id : null;
};

export const executeTiledUpscale = async (
  input: ExecuteTiledUpscaleInput
): Promise<TiledUpscaleResult> => {
  const plan = buildTiledUpscalePlan(input.source.width, input.source.height, input.config);
  const assertCurrent = () => {
    if (!input.isCurrent()) {
      throw new GenerationEngineError(
        "分块放大任务已取消",
        "ENGINE_STALE",
        "请重新启动分块放大。",
        input.engine.provider
      );
    }
  };
  assertCurrent();
  let session: GeneratedDocumentSession | null = null;
  const layerIds: number[] = [];
  try {
    session = await input.adapters.createOutput(
      plan.outputWidth,
      plan.outputHeight,
      `PXD 分块放大 ${input.config.scale}x`,
      input.taskId
    );
    for (let index = 0; index < plan.tiles.length; index += 1) {
      const tile = plan.tiles[index];
      const progress = (phase: TiledUpscaleProgress["phase"]) => input.onProgress?.({
        completed: index,
        total: plan.tiles.length,
        tile,
        phase
      });
      assertCurrent();
      progress("reading");
      const absoluteBounds = {
        left: input.source.bounds.left + tile.source.left,
        top: input.source.bounds.top + tile.source.top,
        right: input.source.bounds.left + tile.source.right,
        bottom: input.source.bounds.top + tile.source.bottom
      };
      let sourceDataUrl = await input.adapters.readTile(
        input.source.documentId,
        absoluteBounds,
        input.taskId
      );
      assertCurrent();
      progress("enhancing");
      const enhancedDataUrl = await input.adapters.enhanceTile(
        input.engine,
        sourceDataUrl,
        tile,
        input.config,
        input.taskId
      );
      sourceDataUrl = "";
      assertCurrent();
      progress("blending");
      const blendedDataUrl = await input.adapters.featherTile(enhancedDataUrl, {
        left: tile.incomingOverlap.left,
        top: tile.incomingOverlap.top,
        outputWidth: tile.output.right - tile.output.left,
        outputHeight: tile.output.bottom - tile.output.top,
        isCurrent: input.isCurrent
      });
      assertCurrent();
      progress("placing");
      const placed = await input.adapters.placeTile(
        blendedDataUrl,
        tile.output,
        index + 1,
        session.documentId,
        input.taskId
      );
      const layerId = extractLayerId(placed);
      if (!layerId) throw new Error(`瓦片 ${index + 1} 未返回 Photoshop 图层 ID`);
      layerIds.push(layerId);
      input.onProgress?.({ completed: index + 1, total: plan.tiles.length, tile, phase: "placing" });
    }
    assertCurrent();
    await input.adapters.finalize(layerIds, session.documentId, input.taskId);
    assertCurrent();
    return { session, plan, layerIds };
  } catch (error) {
    if (session) {
      try {
        await input.adapters.rollback(session, input.taskId);
      } catch (rollbackError) {
        throw new TiledUpscaleRollbackError(error, rollbackError);
      }
    }
    throw error;
  }
};
