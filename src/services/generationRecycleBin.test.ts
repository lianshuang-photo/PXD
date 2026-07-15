import { describe, expect, it } from "vitest";
import {
  RECYCLE_BIN_BYTE_LIMIT,
  RecycleBinSchemaError,
  createPendingRecycleBinEntry,
  parseRecycleBinFile,
  sanitizeRecycleBinParams,
  selectRecycleBinRetention,
  type RecycleBinEntry
} from "./generationRecycleBin";

const entry = (taskId: string, status: RecycleBinEntry["status"], ts: number, bytes = 0): RecycleBinEntry => ({
  taskId,
  prompt: taskId,
  params: {},
  provider: "forge",
  status,
  ts,
  updatedAt: ts,
  assets: bytes ? [{ fileName: `${taskId.padEnd(8, "x")}.png`, mimeType: "image/png", byteLength: bytes }] : [],
  context: { width: 64, height: 64 }
});

describe("generation recycle bin domain", () => {
  it("removes credentials and image payloads while preserving rerunnable controls", () => {
    expect(sanitizeRecycleBinParams({
      apiKey: "key",
      access_token: "token",
      secret: "secret",
      image: "raw",
      baseImage: "raw",
      maskImage: "raw",
      nested: { authorization: "Bearer x", dataUrl: "data:image/png;base64,AAA", steps: 24 },
      imageCount: 3,
      prompt: "safe"
    })).toEqual({ nested: { steps: 24 }, imageCount: 3, prompt: "safe" });
  });

  it("migrates legacy entries but rejects future versions before they can be overwritten", () => {
    const migrated = parseRecycleBinFile([{
      id: "legacy-task",
      createdAt: 10,
      provider: "gemini",
      prompt: "legacy",
      params: {},
      width: 32,
      height: 48
    }]);
    expect(migrated.entries[0]).toMatchObject({
      taskId: "legacy-task",
      status: "failed",
      context: { width: 32, height: 48 }
    });
    expect(() => parseRecycleBinFile({ version: 2, entries: [] }))
      .toThrowError(expect.objectContaining<Partial<RecycleBinSchemaError>>({
        code: "RECYCLE_BIN_VERSION_UNSUPPORTED"
      }));
  });

  it("sanitizes snapshots before persisting them", () => {
    const pending = createPendingRecycleBinEntry({
      taskId: " task ",
      prompt: "prompt",
      provider: "forge",
      params: { apiKey: "no", steps: 30 },
      context: { width: 100, height: 80, documentId: 4 }
    }, 100);
    expect(pending).toMatchObject({
      taskId: "task",
      status: "pending",
      params: { steps: 30 },
      context: { width: 100, height: 80, documentId: 4 }
    });
  });

  it("never evicts pending entries and applies both limits only to terminal entries", () => {
    const pending = Array.from({ length: 52 }, (_, index) => entry(`pending-${index}`, "pending", 1_000 + index));
    const newest = entry("terminal-new", "success", 900, RECYCLE_BIN_BYTE_LIMIT);
    const older = entry("terminal-old", "failed", 800);
    const selected = selectRecycleBinRetention([...pending, older, newest]);
    expect(selected.kept.filter(({ status }) => status === "pending")).toHaveLength(52);
    expect(selected.removed.map(({ taskId }) => taskId)).toEqual(["terminal-new", "terminal-old"]);
  });
});
