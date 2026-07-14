import { incomingFeatherAlpha } from "./tiledUpscale";

export interface FeatherTileOptions {
  left: number;
  top: number;
  outputWidth: number;
  outputHeight: number;
  isCurrent?: () => boolean;
}

const IMAGE_TIMEOUT_MS = 20_000;

export const featherTileDataUrl = async (
  dataUrl: string,
  options: FeatherTileOptions
): Promise<string> => {
  if (typeof Image === "undefined" || typeof document === "undefined") {
    throw new Error("当前环境不支持瓦片羽化");
  }
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const candidate = new Image();
    const timeout = setTimeout(() => reject(new Error("瓦片解码超时")), IMAGE_TIMEOUT_MS);
    candidate.onload = () => {
      clearTimeout(timeout);
      resolve(candidate);
    };
    candidate.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("瓦片图片解码失败"));
    };
    candidate.src = dataUrl;
  });
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  if (!width || !height) throw new Error("瓦片图片尺寸无效");
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("当前环境无法处理瓦片羽化");
  context.drawImage(image, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height);
  const left = options.outputWidth > 0 ? options.left * width / options.outputWidth : 0;
  const top = options.outputHeight > 0 ? options.top * height / options.outputHeight : 0;
  try {
    for (let y = 0; y < height; y += 1) {
      if (y % 64 === 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (options.isCurrent && !options.isCurrent()) throw new Error("分块放大已取消");
      }
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 4 + 3;
        pixels.data[offset] = Math.round(
          pixels.data[offset] * incomingFeatherAlpha(x, y, width, height, left, top)
        );
      }
    }
    context.putImageData(pixels, 0, 0);
    return canvas.toDataURL("image/png");
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
};
