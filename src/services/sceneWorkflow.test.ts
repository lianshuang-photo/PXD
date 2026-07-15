import { describe, expect, it, vi } from "vitest";
import type { GenerationEngine } from "./generationEngine";
import type { SceneSourceCapture } from "./photoshop";
import { normalizeScenePack } from "./scenePacks";
import { executeSceneWorkflow, SceneWorkflowError } from "./sceneWorkflow";

const pack = normalizeScenePack({
  id: "studio",
  name: "Studio",
  promptTemplate: "Use {lighting}",
  options: { lighting: ["soft light"] }
})!;

const capture: SceneSourceCapture = {
  documentId: 7,
  documentWidth: 2000,
  documentHeight: 1000,
  baseImageDataUrl: "data:image/png;base64,QUJD",
  baseWidth: 1024,
  baseHeight: 512,
  selectionBounds: { left: 20, top: 30, right: 600, bottom: 900 },
  referenceImageDataUrl: "data:image/png;base64,REVG",
  selectionChannelName: "__PXD_SCENE_TEST"
};

const engine = () => ({
  provider: "gemini" as const,
  progressMode: "indeterminate" as const,
  generate: vi.fn().mockResolvedValue({ images: ["T1VU"] }),
  cancel: vi.fn().mockReturnValue(true),
  cancelAll: vi.fn().mockReturnValue(0)
}) as unknown as GenerationEngine;

const adapters = () => ({
  captureSource: vi.fn().mockResolvedValue({ ...capture }),
  placeBackground: vi.fn().mockResolvedValue({ layerId: 42 }),
  removePlacement: vi.fn().mockResolvedValue(undefined),
  releaseCapture: vi.fn().mockResolvedValue(undefined),
  waitForSettlement: vi.fn().mockResolvedValue(undefined)
});

const input = (currentEngine: GenerationEngine, currentAdapters: ReturnType<typeof adapters>) => ({
  engine: currentEngine,
  pack,
  prompt: "Use soft light",
  taskId: "scene-task",
  timeoutMs: 30_000,
  targetMaxEdge: 1024,
  protectSubject: true,
  useSelectionReference: true,
  isCurrent: () => true,
  adapters: currentAdapters
});

describe("scene workflow", () => {
  it("passes the canvas and selected subject reference to Gemini and places a protected background", async () => {
    const currentEngine = engine();
    const currentAdapters = adapters();

    const result = await executeSceneWorkflow(input(currentEngine, currentAdapters));

    expect(currentAdapters.captureSource).toHaveBeenCalledWith(expect.objectContaining({
      includeSelection: true,
      preserveSelection: true,
      maxEdge: 1024
    }));
    expect(currentEngine.generate).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "Use soft light",
      baseImageBase64: "QUJD",
      refImagesBase64: ["REVG"],
      taskId: "scene-task"
    }));
    expect(currentAdapters.placeBackground).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: 7 }),
      "data:image/png;base64,T1VU",
      expect.objectContaining({ protectSubject: true, layerName: "PXD 场景 · Studio" })
    );
    expect(currentAdapters.releaseCapture).toHaveBeenCalledOnce();
    expect(currentAdapters.waitForSettlement).toHaveBeenCalledWith("scene-task");
    expect(currentAdapters.removePlacement).not.toHaveBeenCalled();
    expect(result).toEqual({ layerId: 42, image: "T1VU", documentId: 7 });
  });

  it("requires a selection before model upload when protection or reference is enabled", async () => {
    const currentEngine = engine();
    const currentAdapters = adapters();
    currentAdapters.captureSource.mockResolvedValue({
      ...capture,
      selectionBounds: null,
      referenceImageDataUrl: null,
      selectionChannelName: null
    });

    await expect(executeSceneWorkflow(input(currentEngine, currentAdapters)))
      .rejects.toThrow("没有可用的主体选区");
    expect(currentEngine.generate).not.toHaveBeenCalled();
    expect(currentAdapters.releaseCapture).toHaveBeenCalledOnce();
  });

  it("supports full-canvas replacement when subject protection and reference are disabled", async () => {
    const currentEngine = engine();
    const currentAdapters = adapters();
    currentAdapters.captureSource.mockResolvedValue({
      ...capture,
      selectionBounds: null,
      referenceImageDataUrl: null,
      selectionChannelName: null
    });

    await executeSceneWorkflow({
      ...input(currentEngine, currentAdapters),
      protectSubject: false,
      useSelectionReference: false
    });

    expect(currentEngine.generate).toHaveBeenCalledWith(expect.objectContaining({
      baseImageBase64: "QUJD",
      refImagesBase64: undefined
    }));
    expect(currentAdapters.placeBackground).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(String),
      expect.objectContaining({ protectSubject: false })
    );
  });

  it("rolls back a landed layer when cancellation arrives after placement", async () => {
    const currentEngine = engine();
    const currentAdapters = adapters();
    let current = true;
    currentAdapters.placeBackground.mockImplementation(async () => {
      current = false;
      return { layerId: 42 };
    });

    await expect(executeSceneWorkflow({
      ...input(currentEngine, currentAdapters),
      isCurrent: () => current
    })).rejects.toMatchObject({ code: "ENGINE_STALE" });
    expect(currentAdapters.removePlacement).toHaveBeenCalledWith(7, 42, { taskId: "scene-task" });
    expect(currentAdapters.releaseCapture).toHaveBeenCalledOnce();
  });

  it("waits for capture release before checking staleness and rolling back", async () => {
    const currentEngine = engine();
    const currentAdapters = adapters();
    let current = true;
    currentAdapters.releaseCapture.mockImplementation(async () => {
      current = false;
    });

    await expect(executeSceneWorkflow({
      ...input(currentEngine, currentAdapters),
      isCurrent: () => current
    })).rejects.toMatchObject({ code: "ENGINE_STALE" });
    expect(currentAdapters.removePlacement).toHaveBeenCalledWith(7, 42, { taskId: "scene-task" });
  });

  it("waits for a timed-out exact-layer rollback before settling", async () => {
    const currentEngine = engine();
    const currentAdapters = adapters();
    let current = true;
    currentAdapters.placeBackground.mockImplementation(async () => {
      current = false;
      return { layerId: 42 };
    });
    currentAdapters.removePlacement.mockRejectedValue(Object.assign(
      new Error("rollback timed out"),
      { name: "PSOperationTimeoutError" }
    ));

    await expect(executeSceneWorkflow({
      ...input(currentEngine, currentAdapters),
      isCurrent: () => current
    })).rejects.toMatchObject({ code: "ENGINE_STALE" });
    expect(currentAdapters.waitForSettlement).toHaveBeenCalledTimes(2);
  });

  it("removes committed output and exposes recovery failures when capture cleanup fails", async () => {
    const currentEngine = engine();
    const currentAdapters = adapters();
    currentAdapters.releaseCapture.mockRejectedValue(new Error("channel cleanup failed"));

    const error = await executeSceneWorkflow(input(currentEngine, currentAdapters)).catch((caught) => caught);
    expect(error).toBeInstanceOf(SceneWorkflowError);
    expect(error).toMatchObject({ recoveryFailed: true });
    expect(currentAdapters.removePlacement).toHaveBeenCalledWith(7, 42, { taskId: "scene-task" });
  });

  it("preserves a capture-stage recovery failure for the controller", async () => {
    const currentEngine = engine();
    const currentAdapters = adapters();
    currentAdapters.captureSource.mockRejectedValue(Object.assign(
      new Error("selection channel cleanup failed"),
      { recoveryFailed: true }
    ));

    const error = await executeSceneWorkflow(input(currentEngine, currentAdapters)).catch((caught) => caught);
    expect(error).toBeInstanceOf(SceneWorkflowError);
    expect(error).toMatchObject({ recoveryFailed: true });
    expect(currentEngine.generate).not.toHaveBeenCalled();
    expect(currentAdapters.releaseCapture).not.toHaveBeenCalled();
  });

  it("preserves adapter rollback failures after placement starts", async () => {
    const currentEngine = engine();
    const currentAdapters = adapters();
    currentAdapters.placeBackground.mockRejectedValue(Object.assign(
      new Error("landed layer cleanup failed"),
      { recoveryFailed: true }
    ));

    const error = await executeSceneWorkflow(input(currentEngine, currentAdapters)).catch((caught) => caught);
    expect(error).toBeInstanceOf(SceneWorkflowError);
    expect(error).toMatchObject({ recoveryFailed: true });
    expect(currentAdapters.releaseCapture).toHaveBeenCalledOnce();
  });

  it("rolls back a structured partial placement by its known layer ID", async () => {
    const currentEngine = engine();
    const currentAdapters = adapters();
    currentAdapters.placeBackground.mockRejectedValue(Object.assign(
      new Error("post-place lookup failed"),
      { layerId: 73, cleanupComplete: false }
    ));

    await expect(executeSceneWorkflow(input(currentEngine, currentAdapters)))
      .rejects.toThrow("post-place lookup failed");
    expect(currentAdapters.removePlacement).toHaveBeenCalledWith(7, 73, { taskId: "scene-task" });
  });

  it("does not double-delete a partial placement already cleaned by the adapter", async () => {
    const currentEngine = engine();
    const currentAdapters = adapters();
    currentAdapters.placeBackground.mockRejectedValue(Object.assign(
      new Error("post-place validation failed"),
      { layerId: 74, cleanupComplete: true }
    ));

    await expect(executeSceneWorkflow(input(currentEngine, currentAdapters)))
      .rejects.toThrow("post-place validation failed");
    expect(currentAdapters.removePlacement).not.toHaveBeenCalled();
  });

  it("rejects Forge before touching Photoshop", async () => {
    const currentEngine = { ...engine(), provider: "forge" as const } as unknown as GenerationEngine;
    const currentAdapters = adapters();
    await expect(executeSceneWorkflow(input(currentEngine, currentAdapters)))
      .rejects.toMatchObject({ code: "SCENE_PROVIDER_UNSUPPORTED" });
    expect(currentAdapters.captureSource).not.toHaveBeenCalled();
  });
});
