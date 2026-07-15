import { bridge } from "./uxpBridge";
import { deletePresetEntries } from "./presetDeletion";
import { normalizeRelightConfig, type RelightConfig } from "./relight";

const PRESET_FOLDER = "presets";
const PRESET_SCHEMA_VERSION = 2;
const FACTORY_PREFIX = "factory:";
const DEFAULT_CATEGORY = "用户预设";

export type PresetKind = "gemini" | "forge";

export interface PresetMeta {
  name: string;
  fileName: string;
  createdAt: string;
  kind: PresetKind;
  category?: string;
  subCategory?: string;
  isFactory?: boolean;
}

interface PresetBase {
  kind: PresetKind;
  title: string;
  category?: string;
  subCategory?: string;
}

export interface GeminiPreset extends PresetBase {
  kind: "gemini";
  content: string;
  refImages?: string[];
  relightConfig?: RelightConfig;
}

export interface ForgePreset<TData = Record<string, unknown>> extends PresetBase {
  kind: "forge";
  data: TData;
}

export type PresetDefinition<TData = Record<string, unknown>> = GeminiPreset | ForgePreset<TData>;

export interface SavePresetOptions {
  targetFileName?: string;
}

interface PersistedPresetDocument<TData = Record<string, unknown>> {
  version: number;
  createdAt: string;
  kind: PresetKind;
  title: string;
  category?: string;
  subCategory?: string;
  content?: string;
  refImages?: string[];
  relightConfig?: RelightConfig;
  data?: TData;
}

export interface ResolvedPreset<TData = Record<string, unknown>> {
  meta: PresetMeta;
  preset: PresetDefinition<TData>;
  version: number;
}

interface NormalizedDocument<TData = Record<string, unknown>> {
  preset: PresetDefinition<TData>;
  createdAt: string;
  migrated: boolean;
}

const factoryModules = import.meta.glob("../assets/presets/**/*.json", {
  eager: true,
  import: "default"
}) as Record<string, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const cleanLabel = (value: unknown, maxLength = 80) =>
  typeof value === "string" ? value.trim().slice(0, maxLength) : "";

const cleanOptionalLabel = (value: unknown) => cleanLabel(value) || undefined;

const normalizeRefImages = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const images = value
    .filter((candidate): candidate is string => typeof candidate === "string")
    .map((candidate) => candidate.trim())
    .filter(Boolean)
    .slice(0, 8);
  return images.length ? images : undefined;
};

const normalizeNewDocument = <TData>(value: Record<string, unknown>, fallbackTitle: string): NormalizedDocument<TData> | null => {
  const kind = value.kind;
  if (kind !== "gemini" && kind !== "forge") return null;
  const title = cleanLabel(value.title) || fallbackTitle;
  if (!title) return null;
  const category = cleanOptionalLabel(value.category);
  const subCategory = cleanOptionalLabel(value.subCategory);
  const createdAt = cleanLabel(value.createdAt) || new Date(0).toISOString();
  if (kind === "gemini") {
    const content = typeof value.content === "string" ? value.content.trim() : "";
    if (!content) return null;
    const relightConfig = value.relightConfig === undefined
      ? undefined
      : normalizeRelightConfig(value.relightConfig, { strict: true });
    if (value.relightConfig !== undefined && !relightConfig) return null;
    return {
      preset: {
        kind,
        title,
        category,
        subCategory,
        content,
        refImages: normalizeRefImages(value.refImages),
        relightConfig: relightConfig ?? undefined
      },
      createdAt,
      migrated: value.version !== PRESET_SCHEMA_VERSION
    };
  }
  if (!isRecord(value.data)) return null;
  return {
    preset: {
      kind,
      title,
      category,
      subCategory,
      data: value.data as TData
    },
    createdAt,
    migrated: value.version !== PRESET_SCHEMA_VERSION
  };
};

const normalizeLegacyDocument = <TData>(value: Record<string, unknown>, fallbackTitle: string): NormalizedDocument<TData> | null => {
  if (!isRecord(value.meta) || !isRecord(value.data)) return null;
  const legacyForm = isRecord(value.data.form) ? value.data.form : value.data;
  const title = cleanLabel(value.meta.name) || fallbackTitle;
  if (!title) return null;
  return {
    preset: {
      kind: "forge",
      title,
      category: cleanOptionalLabel(value.meta.category) ?? DEFAULT_CATEGORY,
      subCategory: cleanOptionalLabel(value.meta.subCategory),
      data: legacyForm as TData
    },
    createdAt: cleanLabel(value.meta.createdAt) || new Date(0).toISOString(),
    migrated: true
  };
};

export const normalizePresetDocument = <TData = Record<string, unknown>>(
  value: unknown,
  fallbackTitle = ""
): NormalizedDocument<TData> | null => {
  if (!isRecord(value)) return null;
  if (value.version !== undefined && (
    typeof value.version !== "number" ||
    !Number.isInteger(value.version) ||
    value.version < 1 ||
    value.version > PRESET_SCHEMA_VERSION
  )) return null;
  return normalizeNewDocument<TData>(value, fallbackTitle) ?? normalizeLegacyDocument<TData>(value, fallbackTitle);
};

const toPersistedDocument = <TData>(normalized: NormalizedDocument<TData>): PersistedPresetDocument<TData> => {
  const { preset } = normalized;
  return {
    version: PRESET_SCHEMA_VERSION,
    createdAt: normalized.createdAt,
    kind: preset.kind,
    title: preset.title,
    category: preset.category,
    subCategory: preset.subCategory,
    ...(preset.kind === "gemini"
      ? {
          content: preset.content,
          refImages: preset.refImages,
          relightConfig: preset.relightConfig
        }
      : { data: preset.data })
  };
};

const toMeta = <TData>(
  normalized: NormalizedDocument<TData>,
  fileName: string,
  isFactory: boolean
): PresetMeta => ({
  name: normalized.preset.title,
  fileName,
  createdAt: normalized.createdAt,
  kind: normalized.preset.kind,
  category: normalized.preset.category,
  subCategory: normalized.preset.subCategory,
  isFactory
});

const factoryPresets = new Map<string, ResolvedPreset>();
for (const [path, raw] of Object.entries(factoryModules)) {
  const fallbackTitle = path.split("/").pop()?.replace(/\.json$/i, "") ?? "";
  const normalized = normalizePresetDocument(raw, fallbackTitle);
  if (!normalized) {
    console.warn(`Ignored invalid factory preset ${path}`);
    continue;
  }
  const fileName = `${FACTORY_PREFIX}${path}`;
  factoryPresets.set(fileName, {
    meta: toMeta(normalized, fileName, true),
    preset: normalized.preset,
    version: PRESET_SCHEMA_VERSION
  });
}

const sanitizeFileName = (input: string) => input.replace(/[\\/:*?"<>|#]/g, "");

const ensurePresetFolder = async () => await bridge.getOrCreateFolder?.(PRESET_FOLDER);

const presetSort = (left: PresetMeta, right: PresetMeta) => {
  if (Boolean(left.isFactory) !== Boolean(right.isFactory)) return left.isFactory ? -1 : 1;
  return (left.category ?? "未分类").localeCompare(right.category ?? "未分类", "zh-CN") ||
    (left.subCategory ?? "").localeCompare(right.subCategory ?? "", "zh-CN") ||
    left.name.localeCompare(right.name, "zh-CN");
};

const listUserPresetMetas = async (): Promise<PresetMeta[]> => {
  const folder = await ensurePresetFolder();
  if (!folder) return [];
  const entries = await folder.getEntries();
  const presetFileNames = new Set<string>();
  for (const entry of entries) {
    if (!entry?.isFile) continue;
    const name = typeof entry.name === "string" ? entry.name : "";
    if (name.toLowerCase().endsWith(".json")) presetFileNames.add(name);
    else if (name.toLowerCase().endsWith(".json.bak")) presetFileNames.add(name.slice(0, -4));
  }

  const metas: PresetMeta[] = [];
  for (const fileName of presetFileNames) {
    try {
      const raw = await bridge.readJsonEntry<unknown>(folder, fileName, null);
      const fallbackTitle = fileName.replace(/\.json$/i, "");
      const normalized = normalizePresetDocument(raw, fallbackTitle);
      if (!normalized) {
        console.warn(`Ignored invalid user preset ${fileName}`);
        continue;
      }
      if (normalized.migrated) {
        try {
          await bridge.writeJsonEntry(folder, fileName, toPersistedDocument(normalized));
        } catch (error) {
          console.warn(`Failed to migrate preset ${fileName}`, error);
        }
      }
      metas.push(toMeta(normalized, fileName, false));
    } catch (error) {
      console.warn(`Failed to read user preset ${fileName}`, error);
    }
  }
  return metas;
};

export const listPresetMetas = async (): Promise<PresetMeta[]> => {
  const factory = Array.from(factoryPresets.values(), ({ meta }) => meta);
  try {
    return [...factory, ...(await listUserPresetMetas())].sort(presetSort);
  } catch (error) {
    console.error("Failed to list user presets", error);
    return factory.sort(presetSort);
  }
};

export const loadPresetFile = async <TData = Record<string, unknown>>(
  fileName: string
): Promise<ResolvedPreset<TData> | null> => {
  const factory = factoryPresets.get(fileName);
  if (factory) return factory as ResolvedPreset<TData>;
  if (fileName.startsWith(FACTORY_PREFIX)) return null;
  try {
    const folder = await ensurePresetFolder();
    if (!folder) return null;
    const raw = await bridge.readJsonEntry<unknown>(folder, fileName, null);
    const normalized = normalizePresetDocument<TData>(raw, fileName.replace(/\.json$/i, ""));
    if (!normalized) return null;
    if (normalized.migrated) {
      await bridge.writeJsonEntry(folder, fileName, toPersistedDocument(normalized));
    }
    return {
      meta: toMeta(normalized, fileName, false),
      preset: normalized.preset,
      version: PRESET_SCHEMA_VERSION
    };
  } catch (error) {
    console.error(`Failed to load preset ${fileName}`, error);
    return null;
  }
};

export const savePresetFile = async <TData = Record<string, unknown>>(
  name: string,
  preset: PresetDefinition<TData>,
  options: SavePresetOptions = {}
): Promise<ResolvedPreset<TData>> => {
  const sanitized = sanitizeFileName(name).trim().slice(0, 80);
  if (!sanitized) throw new Error("Preset name is required");
  const hasTargetFileName = options.targetFileName !== undefined;
  const targetFileName = options.targetFileName?.trim() ?? "";
  if (targetFileName.toLowerCase().startsWith(FACTORY_PREFIX)) {
    throw new Error("出厂预设为只读，不能覆盖");
  }
  if (hasTargetFileName && (!/^[^/\\\0]+\.json$/i.test(targetFileName) || targetFileName.toLowerCase().endsWith(".json.bak"))) {
    throw new Error("Preset target file name is invalid");
  }
  const fileName = targetFileName || `${sanitized}.json`;
  const folder = await ensurePresetFolder();
  if (!folder) throw new Error("Preset folder is unavailable");
  const normalized = normalizePresetDocument<TData>({
    ...preset,
    title: sanitized,
    version: PRESET_SCHEMA_VERSION,
    createdAt: new Date().toISOString()
  });
  if (!normalized) throw new Error("Preset data is invalid");
  await bridge.writeJsonEntry(folder, fileName, toPersistedDocument(normalized));
  return {
    meta: toMeta(normalized, fileName, false),
    preset: normalized.preset,
    version: PRESET_SCHEMA_VERSION
  };
};

export const deletePresetFile = async (fileName: string): Promise<void> => {
  if (fileName.startsWith(FACTORY_PREFIX)) {
    throw new Error("出厂预设为只读，不能删除");
  }
  const folder = await ensurePresetFolder();
  if (!folder) throw new Error("Preset folder is unavailable");
  await deletePresetEntries(folder, fileName);
};

export const openPresetFolder = async (): Promise<void> => {
  const folder = await ensurePresetFolder();
  if (!folder) throw new Error("无法访问预设目录");
  if (typeof bridge.revealEntry === "function") {
    await bridge.revealEntry(folder);
    return;
  }
  if (typeof (folder as any)?.reveal === "function") {
    await (folder as any).reveal();
    return;
  }
  throw new Error("当前环境不支持打开预设目录");
};
