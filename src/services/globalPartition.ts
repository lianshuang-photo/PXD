export interface PixelBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export type GlobalPartitionOrientation = "single" | "horizontal" | "vertical";
export type PartitionSeamEdge = "left" | "top" | "right" | "bottom";

export interface GlobalPartitionOptions {
  overlap: number;
  maskContract: number;
  maskFeather: number;
}

export interface GlobalPartitionTile {
  id: string;
  index: number;
  coreBounds: PixelBounds;
  captureBounds: PixelBounds;
  targetWidth: number;
  targetHeight: number;
  seamEdges: PartitionSeamEdge[];
}

export interface GlobalPartitionPlan {
  documentWidth: number;
  documentHeight: number;
  orientation: GlobalPartitionOrientation;
  overlap: number;
  scale: number;
  estimatedWorkingBytes: number;
  tiles: GlobalPartitionTile[];
}

export interface GlobalPartitionMask {
  contract: number;
  feather: number;
}

export interface CreateGlobalPartitionPlanInput {
  width: number;
  height: number;
  overlap: number;
  targetMaxEdge: number;
  maxWorkingBytes?: number;
}

export const DEFAULT_GLOBAL_PARTITION_OPTIONS: GlobalPartitionOptions = Object.freeze({
  overlap: 96,
  maskContract: 24,
  maskFeather: 48
});

export const DEFAULT_GLOBAL_PARTITION_MAX_WORKING_BYTES = 96 * 1024 * 1024;
export const GLOBAL_PARTITION_BYTES_PER_TARGET_PIXEL = 32;

const positiveInteger = (value: number, label: string) => {
  if (!Number.isFinite(value) || value < 1) throw new Error(`${label}必须是正整数`);
  return Math.round(value);
};

export const boundsWidth = (bounds: PixelBounds) => bounds.right - bounds.left;
export const boundsHeight = (bounds: PixelBounds) => bounds.bottom - bounds.top;

export const resolveGlobalPartitionMask = (
  plan: GlobalPartitionPlan,
  options: Pick<GlobalPartitionOptions, "maskContract" | "maskFeather">
): GlobalPartitionMask => {
  const requestedContract = Math.max(0, Math.round(Number(options.maskContract) || 0));
  const requestedFeather = Math.max(0, Math.round(Number(options.maskFeather) || 0));
  if (plan.orientation === "single") {
    return { contract: requestedContract, feather: requestedFeather };
  }
  const contract = Math.min(requestedContract, plan.overlap);
  const feather = Math.min(requestedFeather, Math.max(0, plan.overlap - contract));
  return { contract, feather };
};

const targetSizeFor = (bounds: PixelBounds, maxEdge: number) => {
  const width = boundsWidth(bounds);
  const height = boundsHeight(bounds);
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  };
};

const estimatedBytesFor = (tiles: Array<{ targetWidth: number; targetHeight: number }>) =>
  tiles.reduce(
    (total, tile) => total + tile.targetWidth * tile.targetHeight * GLOBAL_PARTITION_BYTES_PER_TARGET_PIXEL,
    0
  );

export const createGlobalPartitionPlan = (
  input: CreateGlobalPartitionPlanInput
): GlobalPartitionPlan => {
  const documentWidth = positiveInteger(input.width, "文档宽度");
  const documentHeight = positiveInteger(input.height, "文档高度");
  const targetMaxEdge = positiveInteger(input.targetMaxEdge, "分区输入尺寸");
  const maxWorkingBytes = Math.max(
    1024 * 1024,
    positiveInteger(
      input.maxWorkingBytes ?? DEFAULT_GLOBAL_PARTITION_MAX_WORKING_BYTES,
      "内存上限"
    )
  );
  const requestedOverlap = Math.max(0, Math.round(Number(input.overlap) || 0));

  let orientation: GlobalPartitionOrientation = "single";
  let overlap = 0;
  let rawTiles: Array<{
    id: string;
    coreBounds: PixelBounds;
    captureBounds: PixelBounds;
    seamEdges: PartitionSeamEdge[];
  }>;

  if (documentWidth > documentHeight) {
    orientation = "horizontal";
    const split = Math.floor(documentWidth / 2);
    overlap = Math.min(requestedOverlap, split, documentWidth - split);
    rawTiles = [
      {
        id: "left",
        coreBounds: { left: 0, top: 0, right: split, bottom: documentHeight },
        captureBounds: {
          left: 0,
          top: 0,
          right: Math.min(documentWidth, split + overlap),
          bottom: documentHeight
        },
        seamEdges: ["right"]
      },
      {
        id: "right",
        coreBounds: { left: split, top: 0, right: documentWidth, bottom: documentHeight },
        captureBounds: {
          left: Math.max(0, split - overlap),
          top: 0,
          right: documentWidth,
          bottom: documentHeight
        },
        seamEdges: ["left"]
      }
    ];
  } else if (documentHeight > documentWidth) {
    orientation = "vertical";
    const split = Math.floor(documentHeight / 2);
    overlap = Math.min(requestedOverlap, split, documentHeight - split);
    rawTiles = [
      {
        id: "top",
        coreBounds: { left: 0, top: 0, right: documentWidth, bottom: split },
        captureBounds: {
          left: 0,
          top: 0,
          right: documentWidth,
          bottom: Math.min(documentHeight, split + overlap)
        },
        seamEdges: ["bottom"]
      },
      {
        id: "bottom",
        coreBounds: { left: 0, top: split, right: documentWidth, bottom: documentHeight },
        captureBounds: {
          left: 0,
          top: Math.max(0, split - overlap),
          right: documentWidth,
          bottom: documentHeight
        },
        seamEdges: ["top"]
      }
    ];
  } else {
    rawTiles = [{
      id: "whole",
      coreBounds: { left: 0, top: 0, right: documentWidth, bottom: documentHeight },
      captureBounds: { left: 0, top: 0, right: documentWidth, bottom: documentHeight },
      seamEdges: []
    }];
  }

  const initialTiles = rawTiles.map((tile, index) => {
    const target = targetSizeFor(tile.captureBounds, targetMaxEdge);
    return {
      ...tile,
      index,
      targetWidth: target.width,
      targetHeight: target.height
    };
  });
  const initialBytes = estimatedBytesFor(initialTiles);
  const memoryScale = initialBytes > maxWorkingBytes
    ? Math.sqrt(maxWorkingBytes / initialBytes)
    : 1;
  const tiles = initialTiles.map((tile) => ({
    ...tile,
    targetWidth: Math.max(1, Math.floor(tile.targetWidth * memoryScale)),
    targetHeight: Math.max(1, Math.floor(tile.targetHeight * memoryScale))
  }));
  const estimatedWorkingBytes = estimatedBytesFor(tiles);
  if (estimatedWorkingBytes > maxWorkingBytes) {
    throw new Error("分区输入在当前内存上限内无法安全处理");
  }

  const firstCaptureWidth = boundsWidth(tiles[0].captureBounds);
  const scale = tiles[0].targetWidth / firstCaptureWidth;
  return {
    documentWidth,
    documentHeight,
    orientation,
    overlap,
    scale,
    estimatedWorkingBytes,
    tiles
  };
};
