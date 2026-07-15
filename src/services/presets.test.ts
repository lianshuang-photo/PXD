import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({
  getOrCreateFolder: vi.fn(),
  readJsonEntry: vi.fn(),
  writeJsonEntry: vi.fn(),
  revealEntry: vi.fn()
}));

vi.mock("./uxpBridge", () => ({ bridge: storage }));

import {
  deletePresetFile,
  listPresetMetas,
  loadPresetFile,
  normalizePresetDocument,
  savePresetFile,
  type ForgePreset,
  type GeminiPreset
} from "./presets";

const folder = {
  getEntries: vi.fn(),
  getEntry: vi.fn()
};

beforeEach(() => {
  vi.clearAllMocks();
  storage.getOrCreateFolder.mockResolvedValue(folder);
  storage.writeJsonEntry.mockResolvedValue(undefined);
  folder.getEntries.mockResolvedValue([]);
});

describe("preset catalog", () => {
  it("exposes bundled Gemini and Forge presets without a user folder", async () => {
    storage.getOrCreateFolder.mockResolvedValue(undefined);

    const metas = await listPresetMetas();

    expect(metas.length).toBeGreaterThanOrEqual(4);
    expect(new Set(metas.map(({ kind }) => kind))).toEqual(new Set(["gemini", "forge"]));
    expect(metas.every(({ isFactory, fileName, category }) =>
      isFactory === true && fileName.startsWith("factory:") && Boolean(category)
    )).toBe(true);

    const loaded = await loadPresetFile(metas[0].fileName);
    expect(loaded?.meta).toEqual(metas[0]);
    expect(loaded?.preset.kind).toBe(metas[0].kind);
    const relightMeta = metas.find(({ name }) => name === "叠加式可视化打光");
    expect(relightMeta).toBeTruthy();
    const relight = await loadPresetFile(relightMeta!.fileName);
    expect(relight?.preset).toMatchObject({
      kind: "gemini",
      relightConfig: {
        opacity: 70,
        lights: [
          expect.objectContaining({ role: "key", type: "softbox", direction: 35 }),
          expect.objectContaining({ role: "rim", type: "spot", temperature: 7000 })
        ]
      }
    });
  });

  it("merges users after factory presets and migrates legacy form envelopes", async () => {
    folder.getEntries.mockResolvedValue([
      { isFile: true, name: "legacy.json" },
      { isFile: true, name: "modern.json.bak" }
    ]);
    storage.readJsonEntry.mockImplementation((_folder, fileName) => {
      if (fileName === "legacy.json") {
        return Promise.resolve({
          version: 1,
          meta: { name: "旧版参数", createdAt: "2025-01-01T00:00:00.000Z" },
          data: { form: { positivePrompt: "legacy", steps: 33 } }
        });
      }
      return Promise.resolve({
        version: 2,
        createdAt: "2026-01-01T00:00:00.000Z",
        kind: "gemini",
        title: "用户清理",
        category: "用户分类",
        content: "clean the image"
      });
    });

    const metas = await listPresetMetas();
    const firstUser = metas.findIndex(({ isFactory }) => !isFactory);
    expect(firstUser).toBeGreaterThan(0);
    expect(metas.slice(0, firstUser).every(({ isFactory }) => isFactory)).toBe(true);
    expect(metas.slice(firstUser).map(({ name, kind }) => ({ name, kind }))).toEqual([
      { name: "用户清理", kind: "gemini" },
      { name: "旧版参数", kind: "forge" }
    ]);
    expect(storage.writeJsonEntry).toHaveBeenCalledOnce();
    expect(storage.writeJsonEntry).toHaveBeenCalledWith(
      folder,
      "legacy.json",
      expect.objectContaining({
        version: 2,
        kind: "forge",
        title: "旧版参数",
        category: "用户预设",
        data: { positivePrompt: "legacy", steps: 33 }
      })
    );
  });

  it("saves both schemas as writable v2 user documents", async () => {
    const gemini: GeminiPreset = {
      kind: "gemini",
      title: "ignored",
      category: "智能修图",
      content: "replace the background",
      refImages: ["data:image/png;base64,REF"],
      relightConfig: {
        opacity: 70,
        lights: [{
          id: "key", type: "softbox", role: "key", x: 0.2, y: 0.3,
          direction: 45, intensity: 0.8, temperature: 5200
        }]
      }
    };
    const forge: ForgePreset = {
      kind: "forge",
      title: "ignored",
      category: "基础生成",
      data: { steps: 30 }
    };

    const savedGemini = await savePresetFile("场景/替换", gemini);
    const savedForge = await savePresetFile("精细重绘", forge);

    expect(savedGemini.meta).toMatchObject({ name: "场景替换", kind: "gemini", isFactory: false });
    expect(savedForge.meta).toMatchObject({ name: "精细重绘", kind: "forge", isFactory: false });
    expect(storage.writeJsonEntry).toHaveBeenNthCalledWith(
      1,
      folder,
      "场景替换.json",
      expect.objectContaining({
        version: 2,
        kind: "gemini",
        content: gemini.content,
        relightConfig: gemini.relightConfig
      })
    );
    expect(storage.writeJsonEntry).toHaveBeenNthCalledWith(
      2,
      folder,
      "精细重绘.json",
      expect.objectContaining({ version: 2, kind: "forge", data: forge.data })
    );
  });

  it("round-trips a complete Gemini relight plan through writable storage", async () => {
    const files = new Map<string, unknown>();
    storage.writeJsonEntry.mockImplementation(async (_folder, fileName, payload) => {
      files.set(fileName, payload);
    });
    storage.readJsonEntry.mockImplementation(async (_folder, fileName, fallback) =>
      files.get(fileName) ?? fallback
    );
    const relightConfig = {
      opacity: 62,
      lights: [
        { id: "key", type: "softbox" as const, role: "key" as const, x: 0.18, y: 0.27, direction: 32, intensity: 0.82, temperature: 5100 },
        { id: "rim", type: "spot" as const, role: "rim" as const, x: 0.84, y: 0.21, direction: 148, intensity: 0.44, temperature: 7200 }
      ]
    };
    const saved = await savePresetFile("双灯人像", {
      kind: "gemini",
      title: "ignored",
      content: "portrait relight",
      relightConfig
    });
    const loaded = await loadPresetFile(saved.meta.fileName);
    expect(loaded?.preset).toEqual(expect.objectContaining({
      kind: "gemini",
      content: "portrait relight",
      relightConfig
    }));
  });

  it("overwrites an external file name in place and keeps save-as separate", async () => {
    const files = new Map<string, unknown>([["legacy.json", {
      version: 2,
      createdAt: "2025-01-01T00:00:00.000Z",
      kind: "forge",
      title: "自定义标题",
      category: "用户预设",
      data: { steps: 20 }
    }]]);
    folder.getEntries.mockImplementation(async () =>
      Array.from(files.keys(), (name) => ({ isFile: true, name }))
    );
    storage.readJsonEntry.mockImplementation(async (_folder, fileName, fallback) =>
      files.get(fileName) ?? fallback
    );
    storage.writeJsonEntry.mockImplementation(async (_folder, fileName, payload) => {
      files.set(`${fileName}.bak`, payload);
      files.set(fileName, payload);
    });
    const preset: ForgePreset = {
      kind: "forge",
      title: "ignored",
      category: "用户预设",
      data: { steps: 36 }
    };

    const overwritten = await savePresetFile("自定义标题", preset, { targetFileName: "legacy.json" });
    let users = (await listPresetMetas()).filter(({ isFactory }) => !isFactory);

    expect(overwritten.meta).toMatchObject({ name: "自定义标题", fileName: "legacy.json" });
    expect(users.map(({ name, fileName }) => ({ name, fileName }))).toEqual([
      { name: "自定义标题", fileName: "legacy.json" }
    ]);
    expect(files.has("自定义标题.json")).toBe(false);
    expect(files.get("legacy.json.bak")).toEqual(files.get("legacy.json"));

    const copy = await savePresetFile("新副本", preset);
    users = (await listPresetMetas()).filter(({ isFactory }) => !isFactory);
    expect(copy.meta.fileName).toBe("新副本.json");
    expect(users.map(({ fileName }) => fileName).sort()).toEqual(["legacy.json", "新副本.json"].sort());
  });

  it("rejects factory overwrite targets before touching writable storage", async () => {
    await expect(savePresetFile("不能覆盖", {
      kind: "forge",
      title: "不能覆盖",
      data: {}
    }, { targetFileName: "factory:../assets/presets/forge/detail-recovery.json" }))
      .rejects.toThrow("出厂预设为只读");
    expect(storage.getOrCreateFolder).not.toHaveBeenCalled();
  });

  it("rejects factory deletion before touching writable storage", async () => {
    await expect(deletePresetFile("factory:../assets/presets/test.json"))
      .rejects.toThrow("出厂预设为只读");
    expect(storage.getOrCreateFolder).not.toHaveBeenCalled();
  });

  it("rejects malformed schemas and bounds reference images", () => {
    expect(normalizePresetDocument({ kind: "gemini", title: "bad", content: "" })).toBeNull();
    const normalized = normalizePresetDocument({
      version: 2,
      kind: "gemini",
      title: "refs",
      content: "prompt",
      refImages: [...Array.from({ length: 10 }, (_, index) => `ref-${index}`), 42]
    });
    expect(normalized?.preset.kind).toBe("gemini");
    if (normalized?.preset.kind === "gemini") expect(normalized.preset.refImages).toHaveLength(8);
    expect(normalizePresetDocument({
      version: 2,
      kind: "gemini",
      title: "bad lights",
      content: "prompt",
      relightConfig: {
        lights: [{ id: "bad", type: "softbox", role: "key", x: "0.2" }]
      }
    })).toBeNull();
    expect(normalizePresetDocument({
      version: 2,
      kind: "gemini",
      title: "duplicate lights",
      content: "prompt",
      relightConfig: {
        lights: [
          { id: "same", type: "softbox", role: "key", x: 0, y: 0, direction: 0, intensity: 1, temperature: 5000 },
          { id: "same", type: "spot", role: "rim", x: 1, y: 1, direction: 180, intensity: 0.5, temperature: 7000 }
        ]
      }
    })).toBeNull();
  });

  it("refuses future schemas without rewriting them as v2", async () => {
    folder.getEntries.mockResolvedValue([{ isFile: true, name: "future.json" }]);
    storage.readJsonEntry.mockResolvedValue({
      version: 3,
      kind: "gemini",
      title: "未来预设",
      category: "未来分类",
      content: "future content",
      relightConfig: {
        lights: [{ id: "future", type: "sun", role: "side", x: 1, y: 0, direction: 180, intensity: 1, temperature: 6500 }]
      },
      futureField: { mustSurvive: true }
    });

    const metas = await listPresetMetas();
    const loaded = await loadPresetFile("future.json");

    expect(metas.some(({ fileName }) => fileName === "future.json")).toBe(false);
    expect(loaded).toBeNull();
    expect(storage.writeJsonEntry).not.toHaveBeenCalled();
    expect(normalizePresetDocument({
      version: 3,
      meta: { name: "伪装旧版" },
      data: { form: { steps: 99 } }
    })).toBeNull();
  });
});
