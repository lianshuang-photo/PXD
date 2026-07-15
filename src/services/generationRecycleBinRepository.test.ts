import { describe, expect, it, vi } from "vitest";
import { RECYCLE_BIN_VERSION, type RecycleBinEntry, type RecycleBinFile } from "./generationRecycleBin";
import {
  GenerationRecycleBinRepository,
  type GenerationRecycleBinStorage
} from "./generationRecycleBinRepository";

const bytes = (...values: number[]) => new Uint8Array(values);
const toBase64 = (value: Uint8Array) => btoa(String.fromCharCode(...value));
const pendingEntry = (assets: RecycleBinEntry["assets"] = []): RecycleBinEntry => ({
  taskId: "task-1",
  prompt: "prompt",
  params: { steps: 20 },
  provider: "forge",
  status: "pending",
  ts: 100,
  updatedAt: 100,
  assets,
  context: { width: 32, height: 32, documentId: 7 }
});

const fakeStorage = (raw: unknown | null = null) => {
  const assets = new Map<string, Uint8Array>();
  const writes: RecycleBinFile[] = [];
  const storage: GenerationRecycleBinStorage = {
    readIndex: vi.fn().mockResolvedValue(raw),
    writeIndex: vi.fn(async (payload) => { writes.push(structuredClone(payload)); }),
    writeAsset: vi.fn(async (name, value) => { assets.set(name, value.slice()); }),
    readAsset: vi.fn(async (name) => assets.get(name)?.slice() ?? null),
    deleteAsset: vi.fn(async (name) => { assets.delete(name); }),
    listAssets: vi.fn(async () => Array.from(assets.keys()))
  };
  return { storage, assets, writes };
};

const input = { taskId: "task-1", prompt: "prompt", params: { steps: 20 }, provider: "forge" as const, context: { width: 32, height: 32 } };

describe("generation recycle bin persistence and recovery", () => {
  it("persists legacy migration and sensitive-param cleanup as canonical data", async () => {
    const fake = fakeStorage([{
      id: "legacy-task",
      createdAt: 10,
      provider: "forge",
      prompt: "legacy",
      params: { apiKey: "must-not-remain", steps: 20 },
      width: 32,
      height: 48
    }]);
    const repository = new GenerationRecycleBinRepository(fake.storage);

    await repository.initialize();

    expect(fake.writes).toHaveLength(1);
    expect(fake.writes[0]).toEqual({
      version: RECYCLE_BIN_VERSION,
      entries: [expect.objectContaining({
        taskId: "legacy-task",
        status: "failed",
        params: { steps: 20 },
        context: { width: 32, height: 48 }
      })]
    });
  });

  it("persists pending entries as aborted on startup and preserves complete recoverable assets", async () => {
    const assetBytes = bytes(1, 2, 3);
    const asset = { fileName: "recover_01.png", mimeType: "image/png" as const, byteLength: assetBytes.byteLength };
    const fake = fakeStorage({ version: RECYCLE_BIN_VERSION, entries: [pendingEntry([asset])] });
    fake.assets.set(asset.fileName, assetBytes);
    const repository = new GenerationRecycleBinRepository(fake.storage, () => 200);

    await repository.initialize();

    expect(repository.getSnapshot()[0]).toMatchObject({ status: "aborted", assets: [asset] });
    expect(fake.writes[fake.writes.length - 1]?.entries[0].status).toBe("aborted");
    expect(await repository.readImages("task-1")).toEqual([
      `data:image/png;base64,${toBase64(assetBytes)}`
    ]);
  });

  it("writes a pending asset manifest before files and marks success only after verified writes", async () => {
    const fake = fakeStorage();
    const events: string[] = [];
    vi.mocked(fake.storage.writeIndex).mockImplementation(async (payload) => {
      fake.writes.push(structuredClone(payload));
      events.push(`index:${payload.entries[0]?.status ?? "empty"}:${payload.entries[0]?.assets.length ?? 0}`);
    });
    vi.mocked(fake.storage.writeAsset).mockImplementation(async (name, value) => {
      events.push("asset");
      fake.assets.set(name, value.slice());
    });
    const repository = new GenerationRecycleBinRepository(fake.storage, () => 200);
    await repository.begin(input);
    await repository.complete("task-1", [toBase64(bytes(4, 5, 6))]);

    expect(events.slice(-4)).toEqual(["index:pending:0", "index:pending:1", "asset", "index:success:1"]);
    expect(repository.getSnapshot()[0]).toMatchObject({ status: "success" });
    expect(repository.getSnapshot()[0].assets[0].fileName).toMatch(/^[a-z0-9][a-z0-9_-]{7,95}\.png$/i);
  });

  it("cleans partial writes and records failure when asset verification fails", async () => {
    const fake = fakeStorage();
    const repository = new GenerationRecycleBinRepository(fake.storage, () => 300);
    await repository.begin(input);
    vi.mocked(fake.storage.writeAsset).mockImplementation(async (name) => {
      fake.assets.set(name, bytes(9));
    });

    await expect(repository.complete("task-1", [toBase64(bytes(1, 2, 3))])).rejects.toThrow("校验失败");

    expect(fake.assets.size).toBe(0);
    expect(repository.getSnapshot()[0]).toMatchObject({ status: "failed", assets: [] });
  });

  it("keeps verified assets recoverable when the final status write fails", async () => {
    const fake = fakeStorage();
    let durableIndex: RecycleBinFile | null = null;
    vi.mocked(fake.storage.readIndex).mockImplementation(async () => structuredClone(durableIndex));
    vi.mocked(fake.storage.writeIndex).mockImplementation(async (payload) => {
      durableIndex = structuredClone(payload);
      fake.writes.push(structuredClone(payload));
    });
    const repository = new GenerationRecycleBinRepository(fake.storage, () => 300);
    await repository.begin(input);
    vi.mocked(fake.storage.writeIndex)
      .mockImplementationOnce(async (payload) => {
        durableIndex = structuredClone(payload);
        fake.writes.push(structuredClone(payload));
      })
      .mockRejectedValueOnce(new Error("final index write failed"));

    await expect(repository.complete("task-1", [toBase64(bytes(1, 2, 3))]))
      .rejects.toThrow("final index write failed");

    expect(repository.getSnapshot()[0]).toMatchObject({ status: "pending", assets: [{ byteLength: 3 }] });
    expect(await repository.readImages("task-1")).toEqual(["data:image/png;base64,AQID"]);

    const restarted = new GenerationRecycleBinRepository(fake.storage, () => 400);
    await restarted.initialize();
    expect(restarted.getSnapshot()[0]).toMatchObject({ status: "aborted", assets: [{ byteLength: 3 }] });
    expect(await restarted.readImages("task-1")).toEqual(["data:image/png;base64,AQID"]);
  });

  it("rolls memory back to the pre-archive state if cleanup status also cannot persist", async () => {
    const fake = fakeStorage();
    const repository = new GenerationRecycleBinRepository(fake.storage, () => 300);
    await repository.begin(input);
    vi.mocked(fake.storage.writeAsset).mockImplementation(async (name) => {
      fake.assets.set(name, bytes(9));
    });
    vi.mocked(fake.storage.writeIndex)
      .mockImplementationOnce(async (payload) => { fake.writes.push(structuredClone(payload)); })
      .mockRejectedValueOnce(new Error("failure status write failed"));

    await expect(repository.complete("task-1", [toBase64(bytes(1, 2, 3))]))
      .rejects.toThrow("校验失败");

    expect(repository.getSnapshot()[0]).toMatchObject({ status: "pending", assets: [] });
    expect(fake.assets.size).toBe(0);
  });

  it("rolls memory back when a mutation cannot be persisted", async () => {
    const fake = fakeStorage();
    const repository = new GenerationRecycleBinRepository(fake.storage);
    await repository.initialize();
    vi.mocked(fake.storage.writeIndex).mockRejectedValueOnce(new Error("disk full"));

    await expect(repository.begin(input)).rejects.toThrow("disk full");
    expect(repository.getSnapshot()).toEqual([]);
  });

  it("serializes reads against replacement cleanup and removes startup orphans", async () => {
    const assetBytes = bytes(1, 2);
    const asset = { fileName: "serial_01.png", mimeType: "image/png" as const, byteLength: 2 };
    const fake = fakeStorage({ version: RECYCLE_BIN_VERSION, entries: [{ ...pendingEntry([asset]), status: "success" }] });
    fake.assets.set(asset.fileName, assetBytes);
    fake.assets.set("orphan_01.png", bytes(8));
    const repository = new GenerationRecycleBinRepository(fake.storage);
    await repository.initialize();
    expect(fake.assets.has("orphan_01.png")).toBe(false);

    let releaseRead!: () => void;
    vi.mocked(fake.storage.readAsset).mockImplementation(async (name) => {
      await new Promise<void>((resolve) => { releaseRead = resolve; });
      return fake.assets.get(name)?.slice() ?? null;
    });

    const reading = repository.readImages("task-1");
    await Promise.resolve();
    const replacing = repository.begin(input);
    await Promise.resolve();
    expect(fake.assets.has(asset.fileName)).toBe(true);
    releaseRead();
    await reading;
    await replacing;
    expect(fake.assets.has(asset.fileName)).toBe(false);
  });

  it("does not write or clean assets when a future index version is found", async () => {
    const fake = fakeStorage({ version: RECYCLE_BIN_VERSION + 1, entries: [] });
    const repository = new GenerationRecycleBinRepository(fake.storage);
    await expect(repository.initialize()).rejects.toMatchObject({ code: "RECYCLE_BIN_VERSION_UNSUPPORTED" });
    expect(fake.storage.writeIndex).not.toHaveBeenCalled();
    expect(fake.storage.deleteAsset).not.toHaveBeenCalled();
  });

  it("marks a same-name partial asset failed during startup recovery", async () => {
    const asset = { fileName: "partial_01.png", mimeType: "image/png" as const, byteLength: 3 };
    const fake = fakeStorage({
      version: RECYCLE_BIN_VERSION,
      entries: [{ ...pendingEntry([asset]), status: "success" }]
    });
    fake.assets.set(asset.fileName, bytes(1));
    const repository = new GenerationRecycleBinRepository(fake.storage, () => 400);

    await repository.initialize();

    expect(repository.getSnapshot()[0]).toMatchObject({ status: "failed", assets: [] });
    expect(fake.writes[fake.writes.length - 1].entries[0].error).toContain("不完整");
  });
});
