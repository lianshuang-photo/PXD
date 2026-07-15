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

export const partitionSeamAlpha = (
  tile: Pick<GlobalPartitionTile, "captureBounds" | "seamEdges">,
  x: number,
  y: number,
  contract: number,
  feather: number
) => {
  const width = boundsWidth(tile.captureBounds);
  const height = boundsHeight(tile.captureBounds);
  if (width <= 0 || height <= 0 || !tile.seamEdges.length) return 1;
  const hard = Math.max(0, contract);
  const soft = Math.max(0, feather);
  const edgeAlpha = (distance: number) => {
    if (distance < hard) return 0;
    if (soft <= 0 || distance >= hard + soft) return 1;
    const progress = Math.max(0, Math.min(1, (distance - hard) / soft));
    return 0.5 - 0.5 * Math.cos(Math.PI * progress);
  };
  let alpha = 1;
  for (const edge of tile.seamEdges) {
    const distance = edge === "left"
      ? x
      : edge === "right"
        ? width - x
        : edge === "top"
          ? y
          : height - y;
    alpha = Math.min(alpha, edgeAlpha(distance));
  }
  return alpha;
};

export const resolveGlobalPartitionMask = (
  plan: GlobalPartitionPlan,
  options: Pick<GlobalPartitionOptions, "maskContract" | "maskFeather">
): GlobalPartitionMask => {
  const requestedContract = Math.max(0, Math.round(Number(options.maskContract) || 0));
  const requestedFeather = Math.max(0, Math.round(Number(options.maskFeather) || 0));
  if (plan.orientation === "single") {
    return { contract: 0, feather: 0 };
  }
  const contract = Math.min(requestedContract, plan.overlap);
  const feather = Math.min(requestedFeather, Math.max(0, plan.overlap - contract));
  return { contract, feather };
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

  const largestCaptureEdge = Math.max(
    ...rawTiles.flatMap((tile) => [
      boundsWidth(tile.captureBounds),
      boundsHeight(tile.captureBounds)
    ])
  );
  const sourcePixelTotal = rawTiles.reduce(
    (total, tile) => total + boundsWidth(tile.captureBounds) * boundsHeight(tile.captureBounds),
    0
  );
  const edgeScale = Math.min(1, targetMaxEdge / largestCaptureEdge);
  const memoryScale = Math.min(
    1,
    Math.sqrt(maxWorkingBytes / (sourcePixelTotal * GLOBAL_PARTITION_BYTES_PER_TARGET_PIXEL))
  );
  const scale = Math.min(edgeScale, memoryScale);
  const tiles = rawTiles.map((tile, index) => ({
    ...tile,
    index,
    targetWidth: Math.max(1, Math.floor(boundsWidth(tile.captureBounds) * scale)),
    targetHeight: Math.max(1, Math.floor(boundsHeight(tile.captureBounds) * scale))
  }));
  const estimatedWorkingBytes = estimatedBytesFor(tiles);
  if (estimatedWorkingBytes > maxWorkingBytes) {
    throw new Error("分区输入在当前内存上限内无法安全处理");
  }

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
