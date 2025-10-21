import { bridge } from "./uxpBridge";

const PRESET_FOLDER = "presets";

export interface PresetMeta {
  name: string;
  fileName: string;
  createdAt: string;
}

export interface PresetFile<T = unknown> {
  meta: PresetMeta;
  data: T;
  version?: number;
}

const sanitizeFileName = (input: string) => input.replace(/[\\/:*?"<>|#]/g, "");

const ensurePresetFolder = async () => {
  const folder = await bridge.getOrCreateFolder?.(PRESET_FOLDER);
  return folder;
};

export const listPresetMetas = async (): Promise<PresetMeta[]> => {
  try {
    const folder = await ensurePresetFolder();
    if (!folder) return [];
    const entries = await folder.getEntries();
    const presets: PresetMeta[] = [];
    for (const entry of entries) {
      if (!entry || !entry.isFile) continue;
      const name: string = entry.name || "";
      if (!name.toLowerCase().endsWith(".json")) continue;
      try {
        const raw = await entry.read();
        const parsed = JSON.parse(raw) as PresetFile;
        if (parsed && parsed.meta && parsed.data !== undefined) {
          presets.push({
            name: parsed.meta.name,
            fileName: entry.name,
            createdAt: parsed.meta.createdAt
          });
        } else {
          presets.push({
            name: name.replace(/\.json$/i, ""),
            fileName: entry.name,
            createdAt: new Date().toISOString()
          });
        }
      } catch {
        presets.push({
          name: name.replace(/\.json$/i, ""),
          fileName: entry.name,
          createdAt: new Date().toISOString()
        });
      }
    }
    presets.sort((a, b) => (a.name || "").localeCompare(b.name || "", "zh-CN"));
    return presets;
  } catch (error) {
    console.error("Failed to list presets", error);
    return [];
  }
};

export const loadPresetFile = async <T = unknown>(fileName: string): Promise<PresetFile<T> | null> => {
  try {
    const folder = await ensurePresetFolder();
    if (!folder) return null;
    const entry = await folder.getEntry(fileName);
    const raw = await entry.read();
    return JSON.parse(raw) as PresetFile<T>;
  } catch (error) {
    console.error(`Failed to load preset ${fileName}`, error);
    return null;
  }
};

export const savePresetFile = async <T = unknown>(name: string, data: T): Promise<PresetFile<T> | null> => {
  try {
    const folder = await ensurePresetFolder();
    if (!folder) return null;
    const sanitized = sanitizeFileName(name).trim();
    if (!sanitized) {
      throw new Error("Preset name is required");
    }
    const fileName = `${sanitized}.json`;
    const payload: PresetFile<T> = {
      meta: {
        name: sanitized,
        fileName,
        createdAt: new Date().toISOString()
      },
      data,
      version: 1
    };
    const file = await folder.createFile(fileName, { overwrite: true });
    await file.write(JSON.stringify(payload, null, 2));
    return payload;
  } catch (error) {
    console.error("Failed to save preset", error);
    throw error;
  }
};

export const deletePresetFile = async (fileName: string): Promise<void> => {
  try {
    const folder = await ensurePresetFolder();
    if (!folder) return;
    const entry = await folder.getEntry(fileName);
    await entry.delete();
  } catch (error) {
    console.error(`Failed to delete preset ${fileName}`, error);
  }
};

export const openPresetFolder = async (): Promise<void> => {
  try {
    const folder = await ensurePresetFolder();
    if (!folder) {
      throw new Error("无法访问预设目录");
    }
    if (typeof bridge.revealEntry === "function") {
      await bridge.revealEntry(folder);
      return;
    }
    if (typeof (folder as any)?.reveal === "function") {
      await (folder as any).reveal();
      return;
    }
    throw new Error("当前环境不支持打开预设目录");
  } catch (error) {
    console.error("Failed to open preset folder", error);
    throw error;
  }
};
