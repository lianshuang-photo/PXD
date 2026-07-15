const NEUTRAL_GRAY = 128;
export const RELIGHT_ENERGY_MAX_PIXELS = 2 * 1024 * 1024;
export const RELIGHT_ENERGY_MAX_ENCODED_BYTES = 5 * 1024 * 1024;
export const RELIGHT_ENERGY_MAX_BASE64_LENGTH =
  Math.ceil(RELIGHT_ENERGY_MAX_ENCODED_BYTES / 3) * 4;
export const RELIGHT_ENERGY_MEMORY_BUDGET_BYTES = 96 * 1024 * 1024;
const MAX_CHUNK_PIXELS = 512 * 1024;
const MEMORY_SAFETY_RESERVE_BYTES = 16 * 1024 * 1024;
const DECODE_TIMEOUT_MS = 15_000;

export interface RelightEnergyLayerSize {
  width: number;
  height: number;
}

export const relightEnergyEncodedByteLength = (value: string): number | null => {
  const prefix = value.match(/^data:image\/[a-z0-9.+-]+;base64,/i)?.[0] ?? "";
  const encoded = value.slice(prefix.length);
  if (
    !encoded ||
    /\s/.test(value) ||
    encoded.length > RELIGHT_ENERGY_MAX_BASE64_LENGTH ||
    encoded.length % 4 === 1 ||
    !/^[a-z0-9+/]*={0,2}$/i.test(encoded) ||
    (encoded.includes("=") && encoded.length % 4 !== 0)
  ) return null;
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  return Math.floor(encoded.length * 3 / 4) - padding;
};

// Budget for the worst overlap during PNG encoding: UTF-16 input/output data URLs,
// encoded buffers, decoded image + canvas RGBA surfaces, one ImageData chunk, and reserve.
export const estimateRelightEnergyPeakBytes = () => {
  const inputBase64Bytes = RELIGHT_ENERGY_MAX_BASE64_LENGTH * 2;
  const worstCasePngBytes = RELIGHT_ENERGY_MAX_PIXELS * 5;
  const outputBase64Bytes = Math.ceil(worstCasePngBytes / 3) * 4 * 2;
  const encodedBuffers = RELIGHT_ENERGY_MAX_ENCODED_BYTES + worstCasePngBytes;
  const rgbaSurfaces = RELIGHT_ENERGY_MAX_PIXELS * 4 * 2;
  const chunk = Math.min(RELIGHT_ENERGY_MAX_PIXELS, MAX_CHUNK_PIXELS) * 4;
  return inputBase64Bytes + outputBase64Bytes + encodedBuffers + rgbaSurfaces +
    chunk + MEMORY_SAFETY_RESERVE_BYTES;
};

export const clampEnergyLayerPixels = (pixels: Uint8ClampedArray) => {
  for (let offset = 0; offset + 3 < pixels.length; offset += 4) {
    pixels[offset] = Math.max(NEUTRAL_GRAY, pixels[offset]);
    pixels[offset + 1] = Math.max(NEUTRAL_GRAY, pixels[offset + 1]);
    pixels[offset + 2] = Math.max(NEUTRAL_GRAY, pixels[offset + 2]);
  }
  return pixels;
};

export const softLightChannel = (base: number, blend: number) => {
  const backdrop = Math.min(255, Math.max(0, base)) / 255;
  const source = 0.5 + (Math.min(255, Math.max(NEUTRAL_GRAY, blend)) - NEUTRAL_GRAY) / 254;
  const result = source <= 0.5
    ? backdrop - (1 - 2 * source) * backdrop * (1 - backdrop)
    : backdrop + (2 * source - 1) * (
        (backdrop <= 0.25
          ? ((16 * backdrop - 12) * backdrop + 4) * backdrop
          : Math.sqrt(backdrop)) - backdrop
      );
  return Math.round(Math.min(1, Math.max(0, result)) * 255);
};

const decodeImage = (dataUrl: string, signal: AbortSignal) => new Promise<HTMLImageElement>((resolve, reject) => {
  if (typeof Image === "undefined") {
    reject(new Error("当前环境不支持能量层像素校验"));
    return;
  }
  const image = new Image();
  const cleanup = () => {
    image.onload = null;
    image.onerror = null;
    signal.removeEventListener("abort", onAbort);
  };
  const onAbort = () => {
    clearTimeout(timer);
    cleanup();
    reject(new Error("能量层像素校验已取消"));
  };
  const timer = setTimeout(() => {
    cleanup();
    reject(new Error("能量层像素校验超时"));
  }, DECODE_TIMEOUT_MS);
  if (signal.aborted) {
    onAbort();
    return;
  }
  signal.addEventListener("abort", onAbort, { once: true });
  image.onload = () => {
    clearTimeout(timer);
    cleanup();
    resolve(image);
  };
  image.onerror = () => {
    clearTimeout(timer);
    cleanup();
    reject(new Error("无法读取模型返回的能量层"));
  };
  image.src = dataUrl;
});

export const prepareRelightEnergyLayer = async (
  dataUrl: string,
  signal: AbortSignal,
  expectedSize?: RelightEnergyLayerSize
): Promise<string> => {
  const prefix = dataUrl.match(/^data:image\/[a-z0-9.+-]+;base64,/i)?.[0] ?? "";
  if (!prefix) {
    throw new Error("模型返回的能量层格式无效");
  }
  const encodedBytes = relightEnergyEncodedByteLength(dataUrl);
  if (encodedBytes === null || encodedBytes > RELIGHT_ENERGY_MAX_ENCODED_BYTES) {
    throw new Error("模型返回的能量层超过安全内存预算");
  }
  if (typeof document === "undefined") throw new Error("当前环境不支持能量层像素校验");
  const image = await decodeImage(dataUrl, signal);
  const width = Math.round(image.naturalWidth || image.width);
  const height = Math.round(image.naturalHeight || image.height);
  const pixels = width * height;
  if (width <= 0 || height <= 0 || !Number.isSafeInteger(pixels) || pixels > RELIGHT_ENERGY_MAX_PIXELS) {
    throw new Error("能量层尺寸无效或超过安全内存预算");
  }
  if (expectedSize && (width !== expectedSize.width || height !== expectedSize.height)) {
    throw new Error(
      `能量层尺寸 ${width}×${height} 与捕获区域 ${expectedSize.width}×${expectedSize.height} 不一致`
    );
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  // Photoshop UXP exposes the baseline Canvas 2D signature used elsewhere in
  // the plugin, but does not consistently accept browser-only context hints.
  const context = canvas.getContext("2d");
  if (!context) throw new Error("当前环境无法校验能量层像素");
  context.drawImage(image, 0, 0, width, height);
  image.src = "";
  dataUrl = "";
  const rowsPerChunk = Math.max(1, Math.floor(MAX_CHUNK_PIXELS / width));
  for (let top = 0; top < height; top += rowsPerChunk) {
    if (signal.aborted) throw new Error("能量层像素校验已取消");
    const rows = Math.min(rowsPerChunk, height - top);
    const chunk = context.getImageData(0, top, width, rows);
    clampEnergyLayerPixels(chunk.data);
    context.putImageData(chunk, 0, top);
    if (top + rows < height && Math.floor(top / rowsPerChunk) % 4 === 3) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
  if (signal.aborted) throw new Error("能量层像素校验已取消");
  const prepared = canvas.toDataURL("image/png");
  if (!/^data:image\/png;base64,/i.test(prepared)) throw new Error("无法编码校验后的能量层");
  return prepared;
};
