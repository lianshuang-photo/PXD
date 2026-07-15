import { describe, expect, it, vi } from "vitest";
import type { GenerationEngine } from "./generationEngine";
import type { AtlasRegionCapture } from "./multiRegionAtlas";
import { executeMultiRegionAtlasWorkflow } from "./multiRegionAtlasWorkflow";

const regions: AtlasRegionCapture[] = [
  {
    id: "one",
    documentId: 7,
    bounds: { left: 10, top: 20, right: 410, bottom: 320 },
    sourceWidth: 400,
    sourceHeight: 300,
    imageWidth: 400,
    imageHeight: 300,
    dataUrl: "data:image/png;base64,QQ==",
    encodedBytes: 1,
    selectionChannelName: "channel-one"
  },
  {
    id: "two",
    documentId: 7,
    bounds: { left: 500, top: 60, right: 700, bottom: 560 },
    sourceWidth: 200,
    sourceHeight: 500,
    imageWidth: 200,
    imageHeight: 500,
    dataUrl: "data:image/png;base64,Qg==",
    encodedBytes: 1,
    selectionChannelName: "channel-two"
  }
];

const createHarness = () => {
  const engine = {
    provider: "gemini",
    progressMode: "indeterminate",
    generate: vi.fn().mockResolvedValue({ images: ["RESULT"] }),
    cancel: vi.fn(),
    cancelAll: vi.fn()
  } as unknown as GenerationEngine;
  const atlas = { base64: "ATLAS", dataUrl: "data:image/png;base64,ATLAS", width: 512, height: 512, encodedBytes: 5 };
  const resultAtlas = { ...atlas, base64: "RESULT", dataUrl: "data:image/png;base64,RESULT" };
  const parts = regions.map((region) => ({
    regionId: region.id,
    dataUrl: `data:${region.id}`,
    width: 100,
    height: 100,
    encodedBytes: 8
  }));
  const adapters = {
    compose: vi.fn().mockResolvedValue(atlas),
    normalize: vi.fn().mockResolvedValue(resultAtlas),
    split: vi.fn().mockResolvedValue(parts),
    place: vi.fn().mockResolvedValue({ layerIds: [41, 42], groupId: 50 })
  };
  return { engine, adapters, atlas, resultAtlas, parts };
};

const execute = (harness: ReturnType<typeof createHarness>, isCurrent = () => true) =>
  executeMultiRegionAtlasWorkflow({
    engine: harness.engine,
    regions: regions.map((region) => ({ ...region, bounds: { ...region.bounds } })),
    prompt: "same treatment",
    targetMaxEdge: 1024,
    timeoutMs: 30_000,
    taskId: "atlas-task",
    maxWorkingBytes: 96 * 1024 * 1024,
    isCurrent,
    adapters: harness.adapters
  });

describe("multi-region atlas workflow", () => {
  it("uses one engine request and places every ledger part atomically", async () => {
    const harness = createHarness();
    const result = await execute(harness);

    expect(harness.engine.generate).toHaveBeenCalledOnce();
    expect(harness.engine.generate).toHaveBeenCalledWith(expect.objectContaining({
      baseImageBase64: "ATLAS",
      taskId: "atlas-task",
      prompt: expect.stringContaining("REGION_2")
    }));
    expect(harness.adapters.place).toHaveBeenCalledWith(
      7,
      expect.arrayContaining([
        expect.objectContaining({ id: "one", dataUrl: "" }),
        expect.objectContaining({ id: "two", dataUrl: "" })
      ]),
      harness.parts,
      expect.objectContaining({ taskId: "atlas-task" })
    );
    expect(harness.adapters.normalize).toHaveBeenCalledWith(
      "RESULT",
      expect.anything(),
      expect.objectContaining({ retainedBytes: expect.any(Number) })
    );
    expect(harness.adapters.split).toHaveBeenCalledWith(
      harness.resultAtlas,
      expect.anything(),
      expect.objectContaining({ retainedBytes: expect.any(Number) })
    );
    expect(result).toMatchObject({ layerIds: [41, 42], groupId: 50 });
    expect(result.previewDataUrl).toBe("data:one");
    expect(result.atlas.dataUrl).toBe("");
    expect(result.resultAtlas.dataUrl).toBe("");
  });

  it("drops a late model result before normalization or Photoshop placement", async () => {
    const harness = createHarness();
    let current = true;
    harness.engine.generate = vi.fn().mockImplementation(async () => {
      current = false;
      return { images: ["LATE"] };
    });

    await expect(execute(harness, () => current)).rejects.toMatchObject({ code: "ENGINE_STALE" });
    expect(harness.adapters.normalize).not.toHaveBeenCalled();
    expect(harness.adapters.place).not.toHaveBeenCalled();
  });

  it("preserves a Photoshop recovery failure from the placement adapter", async () => {
    const harness = createHarness();
    const recoveryError = Object.assign(new Error("恢复文档失败"), { recoveryFailed: true });
    harness.adapters.place.mockRejectedValueOnce(recoveryError);

    await expect(execute(harness)).rejects.toBe(recoveryError);
  });
});
