import type { SelectionPixels } from "./photoshop";

export const REFERENCE_IMAGE_LIMIT = 4;
export const REFERENCE_IMAGE_MAX_EDGE = 768;
export const REFERENCE_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
export const REFERENCE_IMAGES_MAX_TOTAL_BYTES = 12 * 1024 * 1024;
export const REFERENCE_ASPECT_RATIO_WARNING_FOLD = 1.8;

export interface ReferenceImage {
  id: string;
  dataUrl: string;
  width: number;
  height: number;
  capturedAt: string;
}

export class ReferenceImageError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "ReferenceImageError";
    this.code = code;
  }
}

export const dataUrlToBase64 = (value: string) => {
  const separator = value.indexOf(",");
  return (separator >= 0 ? value.slice(separator + 1) : value).replace(/\s/g, "");
};

export const estimateBase64Bytes = (value: string) => {
  const base64 = dataUrlToBase64(value);
  if (!base64) return 0;
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(base64.length * 3 / 4) - padding);
};

const createId = () => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
};

export const appendReferenceImage = (
  current: ReferenceImage[],
  pixels: SelectionPixels
): ReferenceImage[] => {
  if (current.length >= REFERENCE_IMAGE_LIMIT) {
    throw new ReferenceImageError(`最多添加 ${REFERENCE_IMAGE_LIMIT} 张参考图`, "REFERENCE_LIMIT");
  }
  if (!/^data:image\/[a-z0-9.+-]+;base64,/i.test(pixels.dataUrl)) {
    throw new ReferenceImageError("选区未返回有效图片数据", "REFERENCE_DATA_INVALID");
  }
  const bytes = estimateBase64Bytes(pixels.dataUrl);
  if (bytes <= 0 || bytes > REFERENCE_IMAGE_MAX_BYTES) {
    throw new ReferenceImageError("参考图体积过大，请缩小选区后重试", "REFERENCE_IMAGE_TOO_LARGE");
  }
  const totalBytes = current.reduce((sum, image) => sum + estimateBase64Bytes(image.dataUrl), 0) + bytes;
  if (totalBytes > REFERENCE_IMAGES_MAX_TOTAL_BYTES) {
    throw new ReferenceImageError("参考图总体积已达上限，请删除部分图片后重试", "REFERENCE_TOTAL_TOO_LARGE");
  }
  return [...current, {
    id: createId(),
    dataUrl: pixels.dataUrl,
    width: pixels.width,
    height: pixels.height,
    capturedAt: new Date().toISOString()
  }];
};

export const removeReferenceImage = (current: ReferenceImage[], id: string) =>
  current.filter((image) => image.id !== id);

export const moveReferenceImage = (
  current: ReferenceImage[],
  id: string,
  direction: "left" | "right"
) => {
  const index = current.findIndex((image) => image.id === id);
  if (index < 0) return current;
  const target = direction === "left" ? index - 1 : index + 1;
  if (target < 0 || target >= current.length) return current;
  const next = current.slice();
  [next[index], next[target]] = [next[target], next[index]];
  return next;
};

export const referenceImagesToBase64 = (images: ReferenceImage[]) =>
  images.map((image) => dataUrlToBase64(image.dataUrl));

export const getReferenceAspectWarning = (
  main: Pick<SelectionPixels, "width" | "height">,
  references: ReferenceImage[]
): string | null => {
  if (main.width <= 0 || main.height <= 0) return null;
  const mainRatio = main.width / main.height;
  const mismatched = references
    .map((image, index) => ({ image, index }))
    .filter(({ image }) => {
      if (image.width <= 0 || image.height <= 0) return false;
      const ratio = image.width / image.height;
      return Math.max(ratio / mainRatio, mainRatio / ratio) >= REFERENCE_ASPECT_RATIO_WARNING_FOLD;
    })
    .map(({ index }) => index + 1);
  return mismatched.length
    ? `参考图 ${mismatched.join("、")} 与主图比例差异较大，构图可能发生裁切`
    : null;
};
