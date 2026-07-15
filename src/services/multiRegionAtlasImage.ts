import {
  DEFAULT_ATLAS_MAX_WORKING_BYTES,
  type AtlasRegionCapture,
  type MultiRegionAtlasPlan
} from "./multiRegionAtlas";

export interface AtlasImageResult {
  base64: string;
  dataUrl: string;
  width: number;
  height: number;
  encodedBytes: number;
}

export const atlasRetainedBytes = (atlas: AtlasImageResult) =>
  atlas.base64.length * 2 + atlas.dataUrl.length * 2 + atlas.encodedBytes;

const IMAGE_TIMEOUT_MS = 20_000;
const COLORS = ["#22c55e", "#38bdf8", "#f59e0b", "#f472b6", "#a78bfa", "#fb7185"];

const cleanBase64 = (value: string) => value
  .replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "")
  .replace(/\s/g, "");

export const atlasBase64Bytes = (value: string) => {
  const base64 = cleanBase64(value);
  if (!base64 || !/^[a-z0-9+/]*={0,2}$/i.test(base64) || base64.length % 4 === 1) {
    throw new Error("Atlas 图片不是有效的 base64 数据");
  }
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor(base64.length * 3 / 4) - padding;
};

const loadImage = (dataUrl: string) => new Promise<HTMLImageElement>((resolve, reject) => {
  const candidate = new Image();
  const timeout = setTimeout(() => {
    candidate.onload = null;
    candidate.onerror = null;
    reject(new Error("Atlas 图片解码超时"));
  }, IMAGE_TIMEOUT_MS);
  candidate.onload = () => {
    clearTimeout(timeout);
    candidate.onload = null;
    candidate.onerror = null;
    resolve(candidate);
  };
  candidate.onerror = () => {
    clearTimeout(timeout);
    candidate.onload = null;
    candidate.onerror = null;
    reject(new Error("Atlas 图片解码失败"));
  };
  candidate.src = dataUrl;
});

const assertCurrent = (isCurrent?: () => boolean) => {
  if (isCurrent && !isCurrent()) throw new Error("多区拼接任务已取消");
};

const imageDimensions = (image: HTMLImageElement) => ({
  width: image.naturalWidth || image.width,
  height: image.naturalHeight || image.height
});

export const composeMultiRegionAtlas = async (
  regions: AtlasRegionCapture[],
  plan: MultiRegionAtlasPlan,
  isCurrent?: () => boolean
): Promise<AtlasImageResult> => {
  if (typeof Image === "undefined" || typeof document === "undefined") {
    throw new Error("当前环境不支持 Atlas 合成");
  }
  const canvas = document.createElement("canvas");
  canvas.width = plan.width;
  canvas.height = plan.height;
  try {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("当前环境无法绘制 Atlas");
    context.fillStyle = "#101216";
    context.fillRect(0, 0, plan.width, plan.height);
    for (const item of plan.items) {
      assertCurrent(isCurrent);
      const region = regions[item.index];
      if (!region || region.id !== item.regionId) throw new Error("Atlas 布局账与选区不一致");
      const image = await loadImage(region.dataUrl);
      const dimensions = imageDimensions(image);
      if (dimensions.width !== region.imageWidth || dimensions.height !== region.imageHeight) {
        throw new Error(`选区 ${item.index + 1} 的截图尺寸已变化`);
      }
      context.fillStyle = COLORS[item.index % COLORS.length];
      const frame = item.frameBounds;
      context.fillRect(frame.left, frame.top, frame.right - frame.left, frame.bottom - frame.top);
      const content = item.contentBounds;
      context.drawImage(
        image,
        content.left,
        content.top,
        content.right - content.left,
        content.bottom - content.top
      );
    }
    assertCurrent(isCurrent);
    const dataUrl = canvas.toDataURL("image/png");
    const base64 = cleanBase64(dataUrl);
    return {
      base64,
      dataUrl: `data:image/png;base64,${base64}`,
      width: plan.width,
      height: plan.height,
      encodedBytes: atlasBase64Bytes(base64)
    };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
};

export const normalizeMultiRegionAtlasResult = async (
  value: string,
  plan: MultiRegionAtlasPlan,
  options: { maxWorkingBytes?: number; retainedBytes?: number; isCurrent?: () => boolean } = {}
): Promise<AtlasImageResult> => {
  if (typeof Image === "undefined" || typeof document === "undefined") {
    throw new Error("当前环境不支持 Atlas 结果校验");
  }
  const base64 = cleanBase64(value);
  const encodedBytes = atlasBase64Bytes(base64);
  const maxWorkingBytes = Math.max(1024 * 1024, options.maxWorkingBytes ?? DEFAULT_ATLAS_MAX_WORKING_BYTES);
  const retainedBytes = Math.max(0, options.retainedBytes ?? 0);
  if (plan.captureWorkingBytes + retainedBytes + base64.length * 2 + encodedBytes > maxWorkingBytes) {
    throw new Error("Atlas 模型结果的实际字节数超过 96 MiB 工作内存上限");
  }
  const dataUrl = `data:image/png;base64,${base64}`;
  assertCurrent(options.isCurrent);
  const image = await loadImage(dataUrl);
  assertCurrent(options.isCurrent);
  const source = imageDimensions(image);
  if (!source.width || !source.height) throw new Error("Atlas 模型结果尺寸无效");
  const ratioError = Math.abs(source.width / source.height / (plan.width / plan.height) - 1);
  if (ratioError > 0.01) throw new Error("Atlas 模型结果宽高比已变化，无法按布局账安全拆分");
  const sourcePixelBytes = source.width * source.height * 4;
  const fixedBytes = plan.captureWorkingBytes + retainedBytes + base64.length * 2 + encodedBytes + sourcePixelBytes;
  if (!Number.isSafeInteger(sourcePixelBytes) || fixedBytes > maxWorkingBytes) {
    throw new Error("Atlas 模型结果的实际尺寸超过 96 MiB 工作内存上限");
  }
  if (source.width === plan.width && source.height === plan.height) {
    return { base64, dataUrl, width: source.width, height: source.height, encodedBytes };
  }
  const canvas = document.createElement("canvas");
  canvas.width = plan.width;
  canvas.height = plan.height;
  try {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("当前环境无法校正 Atlas 模型结果尺寸");
    context.drawImage(image, 0, 0, plan.width, plan.height);
    assertCurrent(options.isCurrent);
    const normalizedDataUrl = canvas.toDataURL("image/png");
    const normalizedBase64 = cleanBase64(normalizedDataUrl);
    const normalizedEncodedBytes = atlasBase64Bytes(normalizedBase64);
    const peak = fixedBytes + plan.width * plan.height * 4 + normalizedBase64.length * 2 + normalizedEncodedBytes;
    if (peak > maxWorkingBytes) throw new Error("校正后的 Atlas 结果仍超过 96 MiB 工作内存上限");
    return {
      base64: normalizedBase64,
      dataUrl: `data:image/png;base64,${normalizedBase64}`,
      width: plan.width,
      height: plan.height,
      encodedBytes: normalizedEncodedBytes
    };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
};

export const splitMultiRegionAtlas = async (
  atlas: AtlasImageResult,
  plan: MultiRegionAtlasPlan,
  options: { maxWorkingBytes?: number; retainedBytes?: number; isCurrent?: () => boolean } = {}
): Promise<Array<{ regionId: string; dataUrl: string; width: number; height: number }>> => {
  if (typeof Image === "undefined" || typeof document === "undefined") {
    throw new Error("当前环境不支持 Atlas 拆分");
  }
  const maxWorkingBytes = Math.max(1024 * 1024, options.maxWorkingBytes ?? DEFAULT_ATLAS_MAX_WORKING_BYTES);
  const image = await loadImage(atlas.dataUrl);
  const dimensions = imageDimensions(image);
  if (dimensions.width !== plan.width || dimensions.height !== plan.height) {
    throw new Error("Atlas 拆分尺寸与布局账不一致");
  }
  const canvas = document.createElement("canvas");
  const results: Array<{ regionId: string; dataUrl: string; width: number; height: number }> = [];
  let retainedBytes = Math.max(0, options.retainedBytes ?? 0) +
    atlasRetainedBytes(atlas) + plan.width * plan.height * 4;
  try {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("当前环境无法拆分 Atlas");
    for (const item of plan.items) {
      assertCurrent(options.isCurrent);
      const bounds = item.contentBounds;
      const width = bounds.right - bounds.left;
      const height = bounds.bottom - bounds.top;
      canvas.width = width;
      canvas.height = height;
      context.clearRect(0, 0, width, height);
      context.drawImage(image, bounds.left, bounds.top, width, height, 0, 0, width, height);
      const dataUrl = canvas.toDataURL("image/png");
      retainedBytes += dataUrl.length * 2 + atlasBase64Bytes(dataUrl);
      if (plan.captureWorkingBytes + retainedBytes > maxWorkingBytes) {
        throw new Error("Atlas 拆分结果超过 96 MiB 工作内存上限");
      }
      results.push({ regionId: item.regionId, dataUrl, width, height });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    return results;
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
};
