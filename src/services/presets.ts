import { bridge } from "./uxpBridge";
import { deletePresetEntries } from "./presetDeletion";

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
    const presetFileNames = new Set<string>();
    for (const entry of entries) {
      if (!entry || !entry.isFile) continue;
      const name: string = entry.name || "";
      if (name.toLowerCase().endsWith(".json")) {
        presetFileNames.add(name);
      } else if (name.toLowerCase().endsWith(".json.bak")) {
        presetFileNames.add(name.slice(0, -4));
      }
    }
    for (const name of presetFileNames) {
      try {
        const parsed = await bridge.readJsonEntry<PresetFile | null>(folder, name, null);
        if (parsed && parsed.meta && parsed.data !== undefined) {
          presets.push({
            name: parsed.meta.name,
            fileName: name,
            createdAt: parsed.meta.createdAt
          });
        } else {
          presets.push({
            name: name.replace(/\.json$/i, ""),
            fileName: name,
            createdAt: new Date().toISOString()
          });
        }
      } catch {
        presets.push({
          name: name.replace(/\.json$/i, ""),
          fileName: name,
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
    return await bridge.readJsonEntry<PresetFile<T> | null>(folder, fileName, null);
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
    await bridge.writeJsonEntry(folder, fileName, payload);
    return payload;
  } catch (error) {
    console.error("Failed to save preset", error);
    throw error;
  }
};

export const deletePresetFile = async (fileName: string): Promise<void> => {
  try {
    const folder = await ensurePresetFolder();
    if (!folder) {
      throw new Error("Preset folder is unavailable");
    }
    await deletePresetEntries(folder, fileName);
  } catch (error) {
    console.error(`Failed to delete preset ${fileName}`, error);
    throw error;
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
