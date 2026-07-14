import type { AppSettings } from "../context/types";
import { bridge } from "./uxpBridge";

const HISTORY_FILE = "generation-history.json";
const HISTORY_VERSION = 1;
export const GENERATION_HISTORY_LIMIT = 50;
export const MAX_HISTORY_THUMBNAIL_LENGTH = 160 * 1024;
const MAX_PROMPT_LENGTH = 20_000;
const THUMBNAIL_TIMEOUT_MS = 10_000;

export interface GenerationHistoryEntry<TParams = unknown> {
  id: string;
  ts: number;
  provider: AppSettings["imageProvider"];
  prompt: string;
  params: TParams;
  thumbnailDataUrl: string;
}

interface GenerationHistoryFile {
  version: number;
  entries: GenerationHistoryEntry[];
}

export interface GenerationHistoryInput<TParams> {
  provider: AppSettings["imageProvider"];
  prompt: string;
  params: TParams;
  thumbnailDataUrl: string;
}

export class GenerationHistoryError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "GenerationHistoryError";
    this.code = code;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isThumbnailDataUrl = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= MAX_HISTORY_THUMBNAIL_LENGTH &&
  /^data:image\/(?:png|jpe?g|webp);base64,[a-z0-9+/=\s]+$/i.test(value);

const normalizeEntry = (value: unknown): GenerationHistoryEntry | null => {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || value.id.length === 0 || value.id.length > 128) return null;
  if (typeof value.ts !== "number" || !Number.isFinite(value.ts) || value.ts <= 0) return null;
  if (value.provider !== "forge" && value.provider !== "gemini") return null;
  if (typeof value.prompt !== "string" || value.prompt.length > MAX_PROMPT_LENGTH) return null;
  if (!isRecord(value.params) || !isThumbnailDataUrl(value.thumbnailDataUrl)) return null;
  return {
    id: value.id,
    ts: value.ts,
    provider: value.provider,
    prompt: value.prompt,
    params: value.params,
    thumbnailDataUrl: value.thumbnailDataUrl
  };
};

export const normalizeGenerationHistory = (value: unknown): GenerationHistoryEntry[] => {
  const entries = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.entries)
      ? value.entries
      : [];
  const seen = new Set<string>();
  const normalized: GenerationHistoryEntry[] = [];
  for (const candidate of entries) {
    const entry = normalizeEntry(candidate);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    normalized.push(entry);
  }
  return normalized
    .sort((left, right) => right.ts - left.ts)
    .slice(0, GENERATION_HISTORY_LIMIT);
};

export const prependGenerationHistory = <TParams>(
  current: GenerationHistoryEntry<TParams>[],
  entry: GenerationHistoryEntry<TParams>
): GenerationHistoryEntry<TParams>[] =>
  [entry, ...current.filter((candidate) => candidate.id !== entry.id)]
    .sort((left, right) => right.ts - left.ts)
    .slice(0, GENERATION_HISTORY_LIMIT);

const createId = () => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
};

export const createGenerationHistoryEntry = <TParams>(
  input: GenerationHistoryInput<TParams>
): GenerationHistoryEntry<TParams> => ({
  id: createId(),
  ts: Date.now(),
  provider: input.provider,
  prompt: input.prompt.slice(0, MAX_PROMPT_LENGTH),
  params: input.params,
  thumbnailDataUrl: input.thumbnailDataUrl
});

export const loadGenerationHistory = async <TParams = unknown>(): Promise<GenerationHistoryEntry<TParams>[]> => {
  const stored = await bridge.readJsonFile<unknown>(HISTORY_FILE, { version: HISTORY_VERSION, entries: [] });
  return normalizeGenerationHistory(stored) as GenerationHistoryEntry<TParams>[];
};

export const saveGenerationHistory = async <TParams>(entries: GenerationHistoryEntry<TParams>[]): Promise<void> => {
  const payload: GenerationHistoryFile = {
    version: HISTORY_VERSION,
    entries: normalizeGenerationHistory(entries)
  };
  await bridge.writeJsonFile(HISTORY_FILE, payload);
};

const fitWithin = (width: number, height: number, maxEdge: number) => {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  };
};

export const createGenerationThumbnail = async (dataUrl: string): Promise<string> => {
  if (!/^data:image\/[a-z0-9.+-]+;base64,/i.test(dataUrl)) {
    throw new GenerationHistoryError("生成结果不是可用的图片数据", "THUMBNAIL_INPUT_INVALID");
  }
  if (typeof Image === "undefined" || typeof document === "undefined") {
    throw new GenerationHistoryError("当前环境不支持生成历史缩略图", "THUMBNAIL_UNAVAILABLE");
  }

  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const candidate = new Image();
    const timeout = setTimeout(() => {
      candidate.onload = null;
      candidate.onerror = null;
      reject(new GenerationHistoryError("生成历史缩略图处理超时", "THUMBNAIL_TIMEOUT"));
    }, THUMBNAIL_TIMEOUT_MS);
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
      reject(new GenerationHistoryError("无法读取生成结果以创建缩略图", "THUMBNAIL_DECODE_FAILED"));
    };
    candidate.src = dataUrl;
  });

  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  if (!sourceWidth || !sourceHeight) {
    throw new GenerationHistoryError("生成结果尺寸无效", "THUMBNAIL_DIMENSIONS_INVALID");
  }
  if (Math.max(sourceWidth, sourceHeight) <= 256 && dataUrl.length <= MAX_HISTORY_THUMBNAIL_LENGTH) {
    return dataUrl;
  }

  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) {
    throw new GenerationHistoryError("当前环境无法绘制历史缩略图", "THUMBNAIL_CANVAS_UNAVAILABLE");
  }

  const attempts = [
    { edge: 256, quality: 0.72 },
    { edge: 192, quality: 0.62 },
    { edge: 128, quality: 0.52 }
  ];
  for (const attempt of attempts) {
    const size = fitWithin(sourceWidth, sourceHeight, attempt.edge);
    canvas.width = size.width;
    canvas.height = size.height;
    context.clearRect(0, 0, size.width, size.height);
    context.drawImage(image, 0, 0, size.width, size.height);
    const thumbnail = canvas.toDataURL("image/jpeg", attempt.quality);
    if (isThumbnailDataUrl(thumbnail)) return thumbnail;
  }
  throw new GenerationHistoryError("生成结果缩略图仍然过大，未写入历史", "THUMBNAIL_TOO_LARGE");
};
