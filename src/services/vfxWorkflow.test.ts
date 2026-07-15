import { describe, expect, it, vi } from "vitest";
import type { GenerationEngine } from "./generationEngine";
import type { VfxSource } from "./photoshop";
import { DEFAULT_VFX_CONFIG } from "./vfx";
import { executeVfxWorkflow, type VfxWorkflowAdapters } from "./vfxWorkflow";

const source: VfxSource = {
  dataUrl: "data:image/png;base64,c291cmNl",
  documentId: 7,
  documentWidth: 100,
  documentHeight: 80,
  selectionBounds: null
};

const engine = (provider: "gemini" | "forge" = "gemini"): GenerationEngine => ({
  provider,
  progressMode: provider === "gemini" ? "indeterminate" : "determinate",
  generate: vi.fn().mockResolvedValue({ images: ["cmVzdWx0"] }),
  cancel: vi.fn().mockReturnValue(true),
  cancelAll: vi.fn().mockReturnValue(1)
});

const adapters = (): VfxWorkflowAdapters => ({
  capture: vi.fn().mockResolvedValue(source),
  validate: vi.fn().mockResolvedValue(undefined),
  apply: vi.fn().mockResolvedValue({ layerId: 44 }),
  rollback: vi.fn().mockResolvedValue(undefined),
  restore: vi.fn().mockResolvedValue(undefined)
});

const task = (isCurrent = () => true) => ({
  config: { ...DEFAULT_VFX_CONFIG },
  prompt: "cinematic",
  taskId: "vfx-1",
  timeoutMs: 5000,
  signal: new AbortController().signal,
  isCurrent
});

describe("executeVfxWorkflow", () => {
  it("rejects Forge before Photoshop capture", async () => {
    const boundary = adapters();
    await expect(executeVfxWorkflow(engine("forge"), task(), boundary)).rejects.toMatchObject({
      code: "VFX_ENGINE_REQUIRED"
    });
    expect(boundary.capture).not.toHaveBeenCalled();
  });

  it("passes the source, structured prompt, config and task ID through the workflow", async () => {
    const boundary = adapters();
    const phases: string[] = [];
    const gemini = engine();
    const result = await executeVfxWorkflow(gemini, { ...task(), onPhase: (phase) => phases.push(phase) }, boundary);
    expect(phases).toEqual(["preparing", "generating", "applying"]);
    expect(gemini.generate).toHaveBeenCalledWith(expect.objectContaining({
      baseImageBase64: "c291cmNl",
      prompt: expect.stringContaining("cinematic flying sparks"),
      taskId: "vfx-1"
    }));
    expect(boundary.apply).toHaveBeenCalledWith(
      source,
      "data:image/png;base64,cmVzdWx0",
      DEFAULT_VFX_CONFIG,
      "vfx-1",
      expect.any(Function)
    );
    expect(result.layerId).toBe(44);
    expect(boundary.restore).toHaveBeenCalledWith(source, "vfx-1");
  });

  it("prevents apply when cancellation wins after generation", async () => {
    let current = true;
    const gemini = engine();
    vi.mocked(gemini.generate).mockImplementation(async () => {
      current = false;
      return { images: ["cmVzdWx0"] };
    });
    const boundary = adapters();
    await expect(executeVfxWorkflow(gemini, task(() => current), boundary)).rejects.toMatchObject({ code: "CANCELLED" });
    expect(boundary.apply).not.toHaveBeenCalled();
  });

  it("rolls back the exact placed layer after a cancellation race", async () => {
    let current = true;
    const boundary = adapters();
    vi.mocked(boundary.apply).mockImplementation(async () => {
      current = false;
      return { layerId: 91 };
    });
    await expect(executeVfxWorkflow(engine(), task(() => current), boundary)).rejects.toMatchObject({ code: "CANCELLED" });
    expect(boundary.rollback).toHaveBeenCalledWith(source, 91, "vfx-1");
  });

  it("rolls back a committed layer when context restoration fails", async () => {
    const boundary = adapters();
    vi.mocked(boundary.restore).mockRejectedValue(new Error("restore failed"));
    await expect(executeVfxWorkflow(engine(), task(), boundary)).rejects.toThrow("restore failed");
    expect(boundary.rollback).toHaveBeenCalledWith(source, 44, "vfx-1");
  });

  it("rejects an empty engine result without applying", async () => {
    const gemini = engine();
    vi.mocked(gemini.generate).mockResolvedValue({ images: [] });
    const boundary = adapters();
    await expect(executeVfxWorkflow(gemini, task(), boundary)).rejects.toThrow("未返回图像");
    expect(boundary.apply).not.toHaveBeenCalled();
  });
});
