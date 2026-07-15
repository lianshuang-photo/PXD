import { describe, expect, it, vi } from "vitest";
import type { GenerationEngine } from "./generationEngine";
import type { ColorizeSource } from "./photoshop";
import { executeColorizeWorkflow, type ColorizeWorkflowAdapters } from "./colorizeWorkflow";

const source: ColorizeSource = {
  dataUrl: "data:image/png;base64,GRAY",
  documentId: 7,
  documentWidth: 1200,
  documentHeight: 800,
  selectionBounds: { left: 100, top: 80, right: 500, bottom: 380 },
  squareSize: 400
};

const engine = (provider: "forge" | "gemini", generate = vi.fn().mockResolvedValue({ images: ["COLOR"] })) => ({
  provider,
  progressMode: provider === "forge" ? "determinate" : "indeterminate",
  generate,
  cancel: vi.fn(),
  cancelAll: vi.fn()
}) as GenerationEngine;

const adapters = (overrides: Partial<ColorizeWorkflowAdapters> = {}): ColorizeWorkflowAdapters => ({
  prepare: vi.fn().mockResolvedValue(source),
  apply: vi.fn().mockResolvedValue({ layerId: 91 }),
  rollback: vi.fn().mockResolvedValue(undefined),
  restore: vi.fn().mockResolvedValue(undefined),
  ...overrides
});

const task = (overrides: Record<string, unknown> = {}) => ({
  prompt: "warm cinematic colors",
  taskId: "colorize-1",
  timeoutMs: 30_000,
  signal: new AbortController().signal,
  isCurrent: () => true,
  ...overrides
});

describe("executeColorizeWorkflow", () => {
  it("uses only the closed-source engine and preserves structure in its instruction", async () => {
    const generate = vi.fn().mockResolvedValue({ images: ["COLOR"] });
    const photoshop = adapters();
    const phases: string[] = [];

    const result = await executeColorizeWorkflow(
      engine("gemini", generate),
      task({ onPhase: (phase: string) => phases.push(phase) }),
      photoshop
    );

    expect(phases).toEqual(["preparing", "generating", "applying"]);
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      baseImageBase64: "GRAY",
      prompt: expect.stringContaining("Preserve composition, geometry, texture, lighting detail")
    }));
    expect(generate.mock.calls[0][0].prompt).toContain("warm cinematic colors");
    expect(photoshop.apply).toHaveBeenCalledWith(
      source,
      "data:image/png;base64,COLOR",
      "colorize-1",
      expect.any(Function)
    );
    expect(photoshop.restore).toHaveBeenCalledWith(source, "colorize-1");
    expect(result).toEqual({ image: "COLOR", layerId: 91, source });
  });

  it("rejects Forge before touching Photoshop", async () => {
    const photoshop = adapters();

    await expect(executeColorizeWorkflow(engine("forge"), task(), photoshop))
      .rejects.toMatchObject({ code: "COLORIZE_ENGINE_REQUIRED" });
    expect(photoshop.prepare).not.toHaveBeenCalled();
  });

  it("stops before placement when cancellation arrives after generation", async () => {
    let current = true;
    const generate = vi.fn().mockImplementation(async () => {
      current = false;
      return { images: ["LATE"] };
    });
    const photoshop = adapters();

    await expect(executeColorizeWorkflow(
      engine("gemini", generate),
      task({ isCurrent: () => current }),
      photoshop
    )).rejects.toMatchObject({ code: "CANCELLED" });

    expect(photoshop.apply).not.toHaveBeenCalled();
    expect(photoshop.restore).toHaveBeenCalledWith(source, "colorize-1");
  });

  it("fails a nominally successful run when final context restoration fails", async () => {
    const photoshop = adapters({
      restore: vi.fn().mockRejectedValue(new Error("restore failed"))
    });

    await expect(executeColorizeWorkflow(engine("gemini"), task(), photoshop))
      .rejects.toThrow("restore failed");
  });

  it("surfaces rollback failure after cancellation races with placement", async () => {
    let current = true;
    const photoshop = adapters({
      apply: vi.fn().mockImplementation(async () => {
        current = false;
        return { layerId: 91 };
      }),
      rollback: vi.fn().mockRejectedValue(new Error("delete failed"))
    });

    await expect(executeColorizeWorkflow(
      engine("gemini"),
      task({ isCurrent: () => current }),
      photoshop
    )).rejects.toThrow("智能调色已取消；回滚失败：delete failed");

    expect(photoshop.rollback).toHaveBeenCalledWith(source, 91, "colorize-1");
    expect(photoshop.restore).toHaveBeenCalledWith(source, "colorize-1");
  });

  it("combines the primary and context restoration failures", async () => {
    const photoshop = adapters({
      apply: vi.fn().mockRejectedValue(new Error("placement failed")),
      restore: vi.fn().mockRejectedValue(new Error("restore failed"))
    });

    await expect(executeColorizeWorkflow(engine("gemini"), task(), photoshop))
      .rejects.toThrow("placement failed；恢复 Photoshop 上下文失败：restore failed");
  });
});
