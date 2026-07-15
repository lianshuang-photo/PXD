import type { SelectionBounds } from "./photoshop";

export interface AtlasRegionCapture {
  id: string;
  documentId: number;
  bounds: SelectionBounds;
  sourceWidth: number;
  sourceHeight: number;
  imageWidth: number;
  imageHeight: number;
  dataUrl: string;
  encodedBytes: number;
}

export interface AtlasLayoutItem {
  regionId: string;
  index: number;
  column: number;
  frameBounds: SelectionBounds;
  contentBounds: SelectionBounds;
}

export interface MultiRegionAtlasPlan {
  width: number;
  height: number;
  scale: number;
  columns: number;
  gap: number;
  frame: number;
  padding: number;
  captureWorkingBytes: number;
  estimatedWorkingBytes: number;
  items: AtlasLayoutItem[];
}

export interface CreateMultiRegionAtlasPlanInput {
  regions: AtlasRegionCapture[];
  targetMaxEdge: number;
  gap?: number;
  frame?: number;
  padding?: number;
  maxWorkingBytes?: number;
}

export const MAX_ATLAS_REGIONS = 6;
export const DEFAULT_ATLAS_MAX_WORKING_BYTES = 96 * 1024 * 1024;
export const DEFAULT_ATLAS_GAP = 48;
export const DEFAULT_ATLAS_FRAME = 6;
export const DEFAULT_ATLAS_PADDING = 24;
export const ATLAS_WORKING_BYTES_PER_PIXEL = 32;

const positiveInteger = (value: number, label: string) => {
  if (!Number.isFinite(value) || value < 1) throw new Error(`${label}必须是正整数`);
  return Math.round(value);
};

const nonNegativeInteger = (value: number, label: string) => {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label}不能为负数`);
  return Math.round(value);
};

const widthOf = (bounds: SelectionBounds) => bounds.right - bounds.left;
const heightOf = (bounds: SelectionBounds) => bounds.bottom - bounds.top;

interface PackedItem {
  regionId: string;
  index: number;
  column: number;
  outerWidth: number;
  outerHeight: number;
  y: number;
}

const packAtScale = (
  regions: AtlasRegionCapture[],
  scale: number,
  columnCount: number,
  gap: number,
  frame: number,
  padding: number
) => {
  const sized = regions.map((region, index) => ({
    region,
    index,
    contentWidth: Math.max(1, Math.floor(region.imageWidth * scale)),
    contentHeight: Math.max(1, Math.floor(region.imageHeight * scale))
  })).sort((left, right) =>
    right.contentHeight * right.contentWidth - left.contentHeight * left.contentWidth ||
    left.index - right.index
  );
  const columns = Array.from({ length: columnCount }, () => ({ width: 0, height: 0 }));
  const packed: PackedItem[] = [];
  for (const item of sized) {
    let column = 0;
    for (let candidate = 1; candidate < columns.length; candidate += 1) {
      if (columns[candidate].height < columns[column].height) column = candidate;
    }
    const outerWidth = item.contentWidth + frame * 2;
    const outerHeight = item.contentHeight + frame * 2;
    const y = columns[column].height;
    packed.push({
      regionId: item.region.id,
      index: item.index,
      column,
      outerWidth,
      outerHeight,
      y
    });
    columns[column].width = Math.max(columns[column].width, outerWidth);
    columns[column].height += outerHeight + gap;
  }
  for (const column of columns) {
    if (column.height > 0) column.height -= gap;
  }
  const columnXs: number[] = [];
  let nextX = padding;
  for (const column of columns) {
    columnXs.push(nextX);
    nextX += column.width + gap;
  }
  const width = Math.max(1, nextX - gap + padding);
  const height = Math.max(1, Math.max(...columns.map((column) => column.height)) + padding * 2);
  const items = packed.map((item): AtlasLayoutItem => {
    const columnWidth = columns[item.column].width;
    const frameLeft = columnXs[item.column] + Math.floor((columnWidth - item.outerWidth) / 2);
    const frameTop = padding + item.y;
    return {
      regionId: item.regionId,
      index: item.index,
      column: item.column,
      frameBounds: {
        left: frameLeft,
        top: frameTop,
        right: frameLeft + item.outerWidth,
        bottom: frameTop + item.outerHeight
      },
      contentBounds: {
        left: frameLeft + frame,
        top: frameTop + frame,
        right: frameLeft + item.outerWidth - frame,
        bottom: frameTop + item.outerHeight - frame
      }
    };
  }).sort((left, right) => left.index - right.index);
  return { width, height, columns: columnCount, items };
};

const fixedCaptureBytes = (regions: AtlasRegionCapture[]) => {
  const encodedStrings = regions.reduce((total, region) => total + region.dataUrl.length * 2 + region.encodedBytes, 0);
  const largestDecoded = Math.max(...regions.map((region) => region.imageWidth * region.imageHeight * 4));
  return encodedStrings + largestDecoded;
};

const candidateScore = (width: number, height: number) =>
  Math.abs(Math.log(width / height));

export const createMultiRegionAtlasPlan = (
  input: CreateMultiRegionAtlasPlanInput
): MultiRegionAtlasPlan => {
  if (!input.regions.length) throw new Error("请至少添加一个选区");
  if (input.regions.length > MAX_ATLAS_REGIONS) throw new Error(`最多只能添加 ${MAX_ATLAS_REGIONS} 个选区`);
  const documentId = input.regions[0].documentId;
  const ids = new Set<string>();
  for (const region of input.regions) {
    if (!region.id || ids.has(region.id)) throw new Error("选区 ID 必须唯一");
    ids.add(region.id);
    if (region.documentId !== documentId) throw new Error("多区拼接只支持同一个 Photoshop 文档");
    if (
      !Number.isInteger(region.sourceWidth) || !Number.isInteger(region.sourceHeight) ||
      !Number.isInteger(region.imageWidth) || !Number.isInteger(region.imageHeight) ||
      region.sourceWidth <= 0 || region.sourceHeight <= 0 || region.imageWidth <= 0 || region.imageHeight <= 0 ||
      widthOf(region.bounds) !== region.sourceWidth || heightOf(region.bounds) !== region.sourceHeight ||
      !region.dataUrl
    ) {
      throw new Error(`选区 ${region.id} 的截图或几何尺寸无效`);
    }
  }
  const targetMaxEdge = positiveInteger(input.targetMaxEdge, "Atlas 输出边长");
  const gap = nonNegativeInteger(input.gap ?? DEFAULT_ATLAS_GAP, "区域间距");
  const frame = nonNegativeInteger(input.frame ?? DEFAULT_ATLAS_FRAME, "区域边框");
  const padding = nonNegativeInteger(input.padding ?? DEFAULT_ATLAS_PADDING, "画布留白");
  const maxWorkingBytes = positiveInteger(
    input.maxWorkingBytes ?? DEFAULT_ATLAS_MAX_WORKING_BYTES,
    "工作内存上限"
  );
  const fixedBytes = fixedCaptureBytes(input.regions);
  if (fixedBytes >= maxWorkingBytes) {
    throw new Error("选区截图已超过 96 MiB 工作内存上限，请减少区域或分辨率");
  }

  let best: ReturnType<typeof packAtScale> | null = null;
  let bestScale = 0;
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 40; iteration += 1) {
    const scale = (low + high) / 2;
    let scaleBest: ReturnType<typeof packAtScale> | null = null;
    for (let columns = 1; columns <= input.regions.length; columns += 1) {
      const candidate = packAtScale(input.regions, scale, columns, gap, frame, padding);
      const estimated = fixedBytes + candidate.width * candidate.height * ATLAS_WORKING_BYTES_PER_PIXEL;
      if (
        candidate.width > targetMaxEdge || candidate.height > targetMaxEdge ||
        estimated > maxWorkingBytes
      ) continue;
      if (
        !scaleBest ||
        candidateScore(candidate.width, candidate.height) < candidateScore(scaleBest.width, scaleBest.height) ||
        (candidateScore(candidate.width, candidate.height) === candidateScore(scaleBest.width, scaleBest.height) &&
          Math.max(candidate.width, candidate.height) < Math.max(scaleBest.width, scaleBest.height))
      ) {
        scaleBest = candidate;
      }
    }
    if (scaleBest) {
      low = scale;
      bestScale = scale;
      best = scaleBest;
    } else {
      high = scale;
    }
  }
  if (!best || bestScale <= 0) throw new Error("这些选区无法安全拼成 Atlas");
  const estimatedWorkingBytes = fixedBytes + best.width * best.height * ATLAS_WORKING_BYTES_PER_PIXEL;
  return {
    width: best.width,
    height: best.height,
    scale: bestScale,
    columns: best.columns,
    gap,
    frame,
    padding,
    captureWorkingBytes: fixedBytes,
    estimatedWorkingBytes,
    items: best.items
  };
};

export const buildAtlasPrompt = (
  prompt: string,
  plan: MultiRegionAtlasPlan
) => {
  const ledger = plan.items.map((item) => {
    const bounds = item.contentBounds;
    return `REGION_${item.index + 1}: x=${bounds.left}, y=${bounds.top}, width=${widthOf(bounds)}, height=${heightOf(bounds)}`;
  }).join("\n");
  return [
    prompt.trim(),
    "The input is a strict multi-region atlas. Process every REGION independently with one consistent style.",
    "Preserve every region rectangle and all gutters exactly. Do not move content across frames or paint into gutters.",
    "Return one image with exactly the same pixel dimensions and layout as the input atlas.",
    ledger
  ].filter(Boolean).join("\n\n");
};
