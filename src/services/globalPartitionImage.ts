import { DEFAULT_GLOBAL_PARTITION_MAX_WORKING_BYTES } from "./globalPartition";

export interface NormalizeGlobalPartitionImageOptions {
  targetWidth: number;
  targetHeight: number;
  retainedBytes?: number;
  maxWorkingBytes?: number;
  isCurrent?: () => boolean;
}

export interface NormalizedGlobalPartitionImage {
  base64: string;
  dataUrl: string;
  width: number;
  height: number;
  encodedBytes: number;
  estimatedWorkingBytes: number;
}

const IMAGE_TIMEOUT_MS = 20_000;
const RGBA_BYTES_PER_PIXEL = 4;

const cleanBase64 = (value: string) => value
  .replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "")
  .replace(/\s/g, "");

export const decodedBase64Bytes = (value: string) => {
  const base64 = cleanBase64(value);
  if (!base64 || !/^[a-z0-9+/]*={0,2}$/i.test(base64) || base64.length % 4 === 1) {
    throw new Error("Gemini 分区结果不是有效的 base64 图片");
  }
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor(base64.length * 3 / 4) - padding;
};

const loadImage = (dataUrl: string) => new Promise<HTMLImageElement>((resolve, reject) => {
  const candidate = new Image();
  const timeout = setTimeout(() => {
    candidate.onload = null;
    candidate.onerror = null;
    reject(new Error("Gemini 分区结果解码超时"));
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
    reject(new Error("Gemini 分区结果无法解码为图片"));
  };
  candidate.src = dataUrl;
});

const assertCurrent = (isCurrent?: () => boolean) => {
  if (isCurrent && !isCurrent()) throw new Error("大图分区任务已取消");
};

export const normalizeGlobalPartitionImage = async (
  value: string,
  options: NormalizeGlobalPartitionImageOptions
): Promise<NormalizedGlobalPartitionImage> => {
  if (typeof Image === "undefined" || typeof document === "undefined") {
    throw new Error("当前环境不支持分区结果尺寸校验");
  }
  const base64 = cleanBase64(value);
  const encodedBytes = decodedBase64Bytes(base64);
  const maxWorkingBytes = Math.max(
    1024 * 1024,
    Math.floor(options.maxWorkingBytes ?? DEFAULT_GLOBAL_PARTITION_MAX_WORKING_BYTES)
  );
  const retainedBytes = Math.max(0, Math.floor(options.retainedBytes ?? 0));
  const dataUrl = `data:image/png;base64,${base64}`;
  if (retainedBytes + base64.length + encodedBytes > maxWorkingBytes) {
    throw new Error("Gemini 分区结果的实际字节数超过 96 MiB 工作内存上限");
  }

  assertCurrent(options.isCurrent);
  const image = await loadImage(dataUrl);
  assertCurrent(options.isCurrent);
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  if (!Number.isInteger(sourceWidth) || !Number.isInteger(sourceHeight) || sourceWidth <= 0 || sourceHeight <= 0) {
    throw new Error("Gemini 分区结果尺寸无效");
  }
  const sourcePixelBytes = sourceWidth * sourceHeight * RGBA_BYTES_PER_PIXEL;
  const fixedWorkingBytes = retainedBytes + base64.length + encodedBytes + sourcePixelBytes;
  if (!Number.isSafeInteger(sourcePixelBytes) || fixedWorkingBytes > maxWorkingBytes) {
    throw new Error("Gemini 分区结果的实际尺寸超过 96 MiB 工作内存上限");
  }

  const requestedWidth = Math.max(1, Math.floor(options.targetWidth));
  const requestedHeight = Math.max(1, Math.floor(options.targetHeight));
  const targetScale = Math.min(
    1,
    sourceWidth / requestedWidth,
    sourceHeight / requestedHeight
  );
  const targetWidth = Math.max(1, Math.floor(requestedWidth * targetScale));
  const targetHeight = Math.max(1, Math.floor(requestedHeight * targetScale));
  const availableForOutput = maxWorkingBytes - fixedWorkingBytes;
  // Canvas pixels plus an encoded PNG/base64 copy are conservatively budgeted at 10 bytes/pixel.
  const budgetScale = Math.min(
    1,
    Math.sqrt(Math.max(0, availableForOutput) / (targetWidth * targetHeight * 10))
  );
  if (!(budgetScale > 0)) {
    throw new Error("Gemini 分区结果在 96 MiB 工作内存上限内无法安全缩放");
  }
  const width = Math.max(1, Math.floor(targetWidth * budgetScale));
  const height = Math.max(1, Math.floor(targetHeight * budgetScale));
  if (width === sourceWidth && height === sourceHeight) {
    return {
      base64,
      dataUrl,
      width,
      height,
      encodedBytes,
      estimatedWorkingBytes: fixedWorkingBytes
    };
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  try {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("当前环境无法缩放 Gemini 分区结果");
    context.drawImage(image, 0, 0, width, height);
    assertCurrent(options.isCurrent);
    const resizedDataUrl = canvas.toDataURL("image/png");
    const resizedBase64 = cleanBase64(resizedDataUrl);
    const resizedEncodedBytes = decodedBase64Bytes(resizedBase64);
    const estimatedWorkingBytes = fixedWorkingBytes +
      width * height * RGBA_BYTES_PER_PIXEL + resizedBase64.length + resizedEncodedBytes;
    if (estimatedWorkingBytes > maxWorkingBytes) {
      throw new Error("缩放后的 Gemini 分区结果仍超过 96 MiB 工作内存上限");
    }
    return {
      base64: resizedBase64,
      dataUrl: `data:image/png;base64,${resizedBase64}`,
      width,
      height,
      encodedBytes: resizedEncodedBytes,
      estimatedWorkingBytes
    };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
};
