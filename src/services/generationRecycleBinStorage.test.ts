import { beforeEach, describe, expect, it, vi } from "vitest";
import { RECYCLE_BIN_VERSION, type RecycleBinFile } from "./generationRecycleBin";

const mocked = vi.hoisted(() => ({
  bridge: {
    uxp: undefined as unknown,
    getOrCreateFolder: vi.fn()
  }
}));

vi.mock("./uxpBridge", () => ({ bridge: mocked.bridge }));

import { createGenerationRecycleBinStorage } from "./generationRecycleBinStorage";

class MemoryLocalStorage {
  readonly values = new Map<string, string>();
  failPrimary = false;

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    if (this.failPrimary && key === "pxd.recycle-bin.index") throw new Error("interrupted primary write");
    this.values.set(key, value);
  }
}

const file = (taskId: string): RecycleBinFile => ({
  version: RECYCLE_BIN_VERSION,
  entries: [{
    taskId,
    prompt: taskId,
    params: {},
    provider: "forge",
    status: "failed",
    ts: 1,
    updatedAt: 1,
    assets: [],
    context: { width: 32, height: 32 }
  }]
});

describe("generation recycle bin storage adapter", () => {
  beforeEach(() => {
    mocked.bridge.uxp = undefined;
    mocked.bridge.getOrCreateFolder.mockReset();
  });

  it("keeps the previous valid index in .bak and repairs a corrupt primary", async () => {
    const localStorage = new MemoryLocalStorage();
    vi.stubGlobal("window", { localStorage });
    const storage = createGenerationRecycleBinStorage();
    await storage.writeIndex(file("first"));
    await storage.writeIndex(file("second"));
    localStorage.values.set("pxd.recycle-bin.index", "{broken");

    await expect(storage.readIndex()).resolves.toEqual(file("first"));
    expect(JSON.parse(localStorage.getItem("pxd.recycle-bin.index")!)).toEqual(file("first"));
    vi.unstubAllGlobals();
  });

  it("leaves a recoverable previous index when replacing the primary is interrupted", async () => {
    const localStorage = new MemoryLocalStorage();
    vi.stubGlobal("window", { localStorage });
    const storage = createGenerationRecycleBinStorage();
    await storage.writeIndex(file("stable"));
    localStorage.failPrimary = true;
    await expect(storage.writeIndex(file("new"))).rejects.toThrow("interrupted");
    localStorage.failPrimary = false;
    localStorage.values.set("pxd.recycle-bin.index", "{partial");

    await expect(storage.readIndex()).resolves.toEqual(file("stable"));
    vi.unstubAllGlobals();
  });

  it("uses previous-good index.json.bak semantics in the real UXP folder adapter", async () => {
    const texts = new Map<string, string>();
    const assetsFolder = { getEntries: vi.fn().mockResolvedValue([]) };
    const root = {
      getEntry: vi.fn(async (name: string) => {
        if (name === "assets") return assetsFolder;
        if (!texts.has(name)) throw new Error("missing");
        return { read: async () => texts.get(name) };
      }),
      createFolder: vi.fn(async () => assetsFolder),
      createFile: vi.fn(async (name: string) => ({
        write: async (value: string) => { texts.set(name, value); }
      }))
    };
    mocked.bridge.uxp = { storage: { formats: { binary: "binary", utf8: "utf8" } } };
    mocked.bridge.getOrCreateFolder.mockResolvedValue(root);
    const storage = createGenerationRecycleBinStorage();
    await storage.writeIndex(file("uxp-stable"));
    await storage.writeIndex(file("uxp-new"));
    texts.set("index.json", "{partial");

    await expect(storage.readIndex()).resolves.toEqual(file("uxp-stable"));
    expect(JSON.parse(texts.get("index.json")!)).toEqual(file("uxp-stable"));
    expect(JSON.parse(texts.get("index.json.bak")!)).toEqual(file("uxp-stable"));
  });

  it("rejects traversal names before touching the UXP filesystem and filters unsafe entries", async () => {
    const stored = new Map<string, Uint8Array>();
    const assetsFolder = {
      createFile: vi.fn(async (name: string) => ({
        write: async (value: Uint8Array) => { stored.set(name, value.slice()); }
      })),
      getEntries: vi.fn(async () => [{ name: "safe_asset.png" }, { name: "../outside.png" }]),
      getEntry: vi.fn(async (name: string) => ({
        read: async () => stored.get(name),
        delete: async () => { stored.delete(name); }
      }))
    };
    const root = {
      getEntry: vi.fn(async (name: string) => {
        if (name === "assets") return assetsFolder;
        throw new Error("missing");
      }),
      createFolder: vi.fn(async () => assetsFolder)
    };
    mocked.bridge.uxp = { storage: { formats: { binary: "binary", utf8: "utf8" } } };
    mocked.bridge.getOrCreateFolder.mockResolvedValue(root);
    const storage = createGenerationRecycleBinStorage();

    await expect(storage.writeAsset("../outside.png", new Uint8Array([1]))).rejects.toThrow("路径无效");
    expect(assetsFolder.createFile).not.toHaveBeenCalled();
    expect(await storage.listAssets()).toEqual(["safe_asset.png"]);
  });
});
