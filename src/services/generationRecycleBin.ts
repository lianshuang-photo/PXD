import type { AppSettings } from "../context/types";

export const RECYCLE_BIN_VERSION = 1;
export const RECYCLE_BIN_ENTRY_LIMIT = 50;
export const RECYCLE_BIN_BYTE_LIMIT = 512 * 1024 * 1024;
export const RECYCLE_BIN_IMAGE_BYTE_LIMIT = 64 * 1024 * 1024;
export const RECYCLE_BIN_TASK_BYTE_LIMIT = 256 * 1024 * 1024;
export const RECYCLE_BIN_PROMPT_LIMIT = 20_000;

export type RecycleBinStatus = "pending" | "success" | "failed" | "aborted";

export interface RecycleBinSelectionBounds {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export interface RecycleBinContext {
  documentId?: number;
  selectionBounds?: RecycleBinSelectionBounds;
  width: number;
  height: number;
}

export interface RecycleBinAsset {
  fileName: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  byteLength: number;
}

export interface RecycleBinEntry<TParams = Record<string, unknown>> {
  taskId: string;
  prompt: string;
  params: TParams;
  provider: AppSettings["imageProvider"];
  status: RecycleBinStatus;
  ts: number;
  updatedAt: number;
  assets: RecycleBinAsset[];
  context: RecycleBinContext;
  error?: string;
}

export interface RecycleBinFile {
  version: typeof RECYCLE_BIN_VERSION;
  entries: RecycleBinEntry[];
}

export interface RecycleBinTaskInput {
  taskId: string;
  prompt: string;
  params: unknown;
  provider: AppSettings["imageProvider"];
  context: RecycleBinContext;
  ts?: number;
}

export class RecycleBinSchemaError extends Error {
  readonly code: string;

  constructor(message: string, code = "RECYCLE_BIN_SCHEMA_INVALID") {
    super(message);
    this.name = "RecycleBinSchemaError";
    this.code = code;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const normalizePositiveInteger = (value: unknown): number | null =>
  isFiniteNumber(value) && Number.isInteger(value) && value > 0 ? value : null;

const SENSITIVE_PARAM_KEY = /(?:api[_-]?key|authorization|password|secret|token|base64|data[_-]?url|(?:^|[_-])images?(?:$|[_-])|base[_-]?image|init[_-]?images?|source[_-]?image|selection[_-]?pixels?)/i;
const MAX_PARAM_DEPTH = 6;
const MAX_PARAM_KEYS = 128;
const MAX_PARAM_ARRAY = 64;
const MAX_PARAM_STRING = 4_096;

const isSensitiveParamKey = (key: string) =>
  SENSITIVE_PARAM_KEY.test(key) || (/image/i.test(key) && !/^imageCount$/i.test(key));

const sanitizeValue = (value: unknown, depth: number): unknown => {
  if (depth > MAX_PARAM_DEPTH) return undefined;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    if (/^data:image\//i.test(value) || value.length > MAX_PARAM_STRING) return undefined;
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_PARAM_ARRAY)
      .map((candidate) => sanitizeValue(candidate, depth + 1))
      .filter((candidate) => candidate !== undefined);
  }
  if (!isRecord(value)) return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, candidate] of Object.entries(value).slice(0, MAX_PARAM_KEYS)) {
    if (!key || key.length > 128 || isSensitiveParamKey(key)) continue;
    const sanitized = sanitizeValue(candidate, depth + 1);
    if (sanitized !== undefined) result[key] = sanitized;
  }
  return result;
};

export const sanitizeRecycleBinParams = (value: unknown): Record<string, unknown> => {
  const sanitized = sanitizeValue(value, 0);
  return isRecord(sanitized) ? sanitized : {};
};

const normalizeBounds = (value: unknown): RecycleBinSelectionBounds | undefined => {
  if (!isRecord(value)) return undefined;
  const { top, left, bottom, right } = value;
  if (![top, left, bottom, right].every(isFiniteNumber)) return undefined;
  if ([top, left, bottom, right].some((candidate) => Math.abs(candidate as number) > 1_000_000)) return undefined;
  if ((bottom as number) <= (top as number) || (right as number) <= (left as number)) return undefined;
  return { top: top as number, left: left as number, bottom: bottom as number, right: right as number };
};

export const normalizeRecycleBinContext = (value: unknown): RecycleBinContext | null => {
  if (!isRecord(value)) return null;
  const width = normalizePositiveInteger(value.width);
  const height = normalizePositiveInteger(value.height);
  if (!width || !height || width > 32_768 || height > 32_768) return null;
  const documentId = normalizePositiveInteger(value.documentId) ?? undefined;
  const selectionBounds = normalizeBounds(value.selectionBounds);
  return { width, height, ...(documentId ? { documentId } : {}), ...(selectionBounds ? { selectionBounds } : {}) };
};

export const isSafeRecycleBinAssetName = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z0-9][a-z0-9_-]{7,95}\.(?:png|jpe?g|webp)$/i.test(value);

const normalizeAsset = (value: unknown): RecycleBinAsset | null => {
  if (!isRecord(value) || !isSafeRecycleBinAssetName(value.fileName)) return null;
  if (value.mimeType !== "image/png" && value.mimeType !== "image/jpeg" && value.mimeType !== "image/webp") return null;
  const extension = value.fileName.split(".").pop()?.toLowerCase();
  if ((value.mimeType === "image/png" && extension !== "png") ||
      (value.mimeType === "image/jpeg" && extension !== "jpg" && extension !== "jpeg") ||
      (value.mimeType === "image/webp" && extension !== "webp")) return null;
  const byteLength = normalizePositiveInteger(value.byteLength);
  if (!byteLength || byteLength > RECYCLE_BIN_IMAGE_BYTE_LIMIT) return null;
  return { fileName: value.fileName, mimeType: value.mimeType, byteLength };
};

const normalizeStatus = (value: unknown): RecycleBinStatus | null =>
  value === "pending" || value === "success" || value === "failed" || value === "aborted" ? value : null;

const normalizeEntry = (value: unknown): RecycleBinEntry | null => {
  if (!isRecord(value)) return null;
  if (typeof value.taskId !== "string" || !value.taskId.trim() || value.taskId.length > 128) return null;
  if (typeof value.prompt !== "string" || value.prompt.length > RECYCLE_BIN_PROMPT_LIMIT) return null;
  if (value.provider !== "forge" && value.provider !== "gemini") return null;
  const status = normalizeStatus(value.status);
  const ts = normalizePositiveInteger(value.ts);
  const updatedAt = normalizePositiveInteger(value.updatedAt) ?? ts;
  const context = normalizeRecycleBinContext(value.context);
  if (!status || !ts || !updatedAt || !context || !Array.isArray(value.assets)) return null;
  const assets = value.assets.map(normalizeAsset);
  if (assets.some((asset) => asset === null)) return null;
  const normalizedAssets = assets as RecycleBinAsset[];
  if (new Set(normalizedAssets.map(({ fileName }) => fileName)).size !== normalizedAssets.length) return null;
  if (normalizedAssets.reduce((total, asset) => total + asset.byteLength, 0) > RECYCLE_BIN_TASK_BYTE_LIMIT) return null;
  if (status === "success" && normalizedAssets.length === 0) return null;
  const error = typeof value.error === "string" && value.error.length <= 4_096 ? value.error : undefined;
  return {
    taskId: value.taskId,
    prompt: value.prompt,
    params: sanitizeRecycleBinParams(value.params),
    provider: value.provider,
    status,
    ts,
    updatedAt,
    assets: normalizedAssets,
    context,
    ...(error ? { error } : {})
  };
};

const migrateLegacyEntry = (value: unknown): unknown => {
  if (!isRecord(value)) return value;
  const legacyAssets = Array.isArray(value.assets) ? value.assets : [];
  return {
    ...value,
    taskId: value.taskId ?? value.id,
    ts: value.ts ?? value.createdAt,
    updatedAt: value.updatedAt ?? value.ts ?? value.createdAt,
    status: value.status ?? (legacyAssets.length > 0 ? "success" : "failed"),
    assets: legacyAssets,
    context: value.context ?? { width: value.width, height: value.height }
  };
};

export const parseRecycleBinFile = (value: unknown): RecycleBinFile => {
  let candidates: unknown[];
  if (Array.isArray(value)) {
    candidates = value.map(migrateLegacyEntry);
  } else if (isRecord(value)) {
    if (typeof value.version === "number" && value.version > RECYCLE_BIN_VERSION) {
      throw new RecycleBinSchemaError("回收站索引来自更高版本，已拒绝覆盖", "RECYCLE_BIN_VERSION_UNSUPPORTED");
    }
    if (value.version !== undefined && value.version !== 0 && value.version !== RECYCLE_BIN_VERSION) {
      throw new RecycleBinSchemaError("回收站索引版本无效");
    }
    if (!Array.isArray(value.entries)) throw new RecycleBinSchemaError("回收站索引 entries 无效");
    candidates = value.version === RECYCLE_BIN_VERSION ? value.entries : value.entries.map(migrateLegacyEntry);
  } else {
    throw new RecycleBinSchemaError("回收站索引格式无效");
  }
  const seen = new Set<string>();
  const entries: RecycleBinEntry[] = [];
  for (const candidate of candidates) {
    const entry = normalizeEntry(candidate);
    if (!entry || seen.has(entry.taskId)) continue;
    seen.add(entry.taskId);
    entries.push(entry);
  }
  return { version: RECYCLE_BIN_VERSION, entries: entries.sort((left, right) => right.ts - left.ts) };
};

export const createPendingRecycleBinEntry = (input: RecycleBinTaskInput, now = Date.now()): RecycleBinEntry => {
  const taskId = input.taskId.trim();
  const context = normalizeRecycleBinContext(input.context);
  if (!taskId || taskId.length > 128 || !context) throw new RecycleBinSchemaError("回收站任务快照无效");
  if (typeof input.prompt !== "string") throw new RecycleBinSchemaError("回收站 prompt 无效");
  if (input.provider !== "forge" && input.provider !== "gemini") throw new RecycleBinSchemaError("回收站 provider 无效");
  const ts = normalizePositiveInteger(input.ts) ?? Math.max(1, Math.floor(now));
  return {
    taskId,
    prompt: input.prompt.slice(0, RECYCLE_BIN_PROMPT_LIMIT),
    params: sanitizeRecycleBinParams(input.params),
    provider: input.provider,
    status: "pending",
    ts,
    updatedAt: Math.max(ts, Math.floor(now)),
    assets: [],
    context
  };
};

export const recoverInterruptedEntries = (entries: RecycleBinEntry[], now = Date.now()): RecycleBinEntry[] =>
  entries.map((entry) => entry.status === "pending" ? {
    ...entry,
    status: "aborted",
    updatedAt: Math.max(entry.updatedAt, Math.floor(now)),
    error: "Photoshop 上次退出时任务仍在进行，已标记为中断"
  } : entry);

export const selectRecycleBinRetention = (entries: RecycleBinEntry[]): {
  kept: RecycleBinEntry[];
  removed: RecycleBinEntry[];
} => {
  const pending = entries.filter(({ status }) => status === "pending");
  const terminal = entries.filter(({ status }) => status !== "pending").sort((left, right) => right.ts - left.ts);
  const keptTerminal: RecycleBinEntry[] = [];
  const removed: RecycleBinEntry[] = [];
  let totalBytes = pending.reduce((total, entry) => total + entry.assets.reduce((sum, asset) => sum + asset.byteLength, 0), 0);
  const terminalLimit = Math.max(0, RECYCLE_BIN_ENTRY_LIMIT - pending.length);
  for (const entry of terminal) {
    const bytes = entry.assets.reduce((sum, asset) => sum + asset.byteLength, 0);
    if (keptTerminal.length >= terminalLimit || totalBytes + bytes > RECYCLE_BIN_BYTE_LIMIT) removed.push(entry);
    else {
      keptTerminal.push(entry);
      totalBytes += bytes;
    }
  }
  return {
    kept: [...pending, ...keptTerminal].sort((left, right) => right.ts - left.ts),
    removed
  };
};
