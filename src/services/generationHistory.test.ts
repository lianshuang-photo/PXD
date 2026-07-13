import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({
  readJsonFile: vi.fn(),
  writeJsonFile: vi.fn()
}));

vi.mock("./uxpBridge", () => ({
  bridge: storage
}));

import {
  GENERATION_HISTORY_LIMIT,
  MAX_HISTORY_THUMBNAIL_LENGTH,
  createGenerationThumbnail,
  loadGenerationHistory,
  normalizeGenerationHistory,
  saveGenerationHistory,
  type GenerationHistoryEntry
} from "./generationHistory";

const thumbnail = "data:image/jpeg;base64,AAAA";

const entry = (index: number): GenerationHistoryEntry<Record<string, unknown>> => ({
  id: `entry-${index}`,
  ts: 1_000 + index,
  provider: index % 2 ? "gemini" : "forge",
  prompt: `prompt-${index}`,
  params: { steps: index },
  thumbnailDataUrl: thumbnail
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("generation history persistence", () => {
  it("loads, validates, sorts, deduplicates, and caps persisted entries", async () => {
    const candidates = Array.from({ length: 60 }, (_, index) => entry(index));
    candidates.push(entry(59));
    storage.readJsonFile.mockResolvedValue({
      version: 1,
      entries: [
        { ...entry(80), thumbnailDataUrl: `data:image/jpeg;base64,${"A".repeat(MAX_HISTORY_THUMBNAIL_LENGTH)}` },
        { id: "invalid" },
        ...candidates
      ]
    });

    const loaded = await loadGenerationHistory();

    expect(storage.readJsonFile).toHaveBeenCalledWith("generation-history.json", {
      version: 1,
      entries: []
    });
    expect(loaded).toHaveLength(GENERATION_HISTORY_LIMIT);
    expect(loaded[0].id).toBe("entry-59");
    expect(new Set(loaded.map(({ id }) => id)).size).toBe(GENERATION_HISTORY_LIMIT);
    expect(loaded.some(({ id }) => id === "invalid" || id === "entry-80")).toBe(false);
  });

  it("writes a bounded versioned file instead of app settings", async () => {
    storage.writeJsonFile.mockResolvedValue(undefined);
    const entries = Array.from({ length: 55 }, (_, index) => entry(index));

    await saveGenerationHistory(entries);

    expect(storage.writeJsonFile).toHaveBeenCalledOnce();
    const [fileName, payload] = storage.writeJsonFile.mock.calls[0];
    expect(fileName).toBe("generation-history.json");
    expect(payload.version).toBe(1);
    expect(payload.entries).toHaveLength(GENERATION_HISTORY_LIMIT);
    expect(payload.entries[0].id).toBe("entry-54");
  });

  it("accepts the legacy list shape while preserving the same capacity boundary", () => {
    const normalized = normalizeGenerationHistory([entry(1), entry(2)]);
    expect(normalized.map(({ id }) => id)).toEqual(["entry-2", "entry-1"]);
  });
});

describe("generation history thumbnails", () => {
  it("downscales a generated image before it reaches persistence", async () => {
    const drawImage = vi.fn();
    const clearRect = vi.fn();
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn().mockReturnValue({ drawImage, clearRect }),
      toDataURL: vi.fn().mockReturnValue(thumbnail)
    };
    class FakeImage {
      naturalWidth = 1024;
      naturalHeight = 512;
      width = 1024;
      height = 512;
      onload: null | (() => void) = null;
      onerror: null | (() => void) = null;

      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal("Image", FakeImage);
    vi.stubGlobal("document", {
      createElement: vi.fn().mockReturnValue(canvas)
    });

    const result = await createGenerationThumbnail(`data:image/png;base64,${"A".repeat(200_000)}`);

    expect(result).toBe(thumbnail);
    expect(canvas.width).toBe(256);
    expect(canvas.height).toBe(128);
    expect(drawImage).toHaveBeenCalledOnce();
    expect(canvas.toDataURL).toHaveBeenCalledWith("image/jpeg", 0.72);
  });
});
