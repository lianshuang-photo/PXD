import { describe, expect, it, vi } from "vitest";
import type { GenerationEngine } from "./generationEngine";
import { createDefaultRelightLights } from "./relight";
import { RELIGHT_ENERGY_MAX_BASE64_LENGTH } from "./relightEnergyLayer";
import { executeRelightWorkflow, type RelightWorkflowAdapters } from "./relightWorkflow";

const source = {
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

const adapters = (): RelightWorkflowAdapters => ({
  capture: vi.fn().mockResolvedValue(source),
  validate: vi.fn().mockResolvedValue(undefined),
  prepare: vi.fn().mockImplementation(async (dataUrl) => dataUrl),
  apply: vi.fn().mockResolvedValue({ layerId: 44 }),
  rollback: vi.fn().mockResolvedValue(undefined),
  restore: vi.fn().mockResolvedValue(undefined)
});

const task = (isCurrent = () => true) => ({
  lights: createDefaultRelightLights(),
  opacity: 63,
  prompt: "portrait",
  taskId: "relight-1",
  timeoutMs: 5000,
  signal: new AbortController().signal,
  isCurrent
});

describe("executeRelightWorkflow", () => {
  it("rejects Forge before touching Photoshop", async () => {
    const boundary = adapters();
    await expect(executeRelightWorkflow(engine("forge"), task(), boundary)).rejects.toMatchObject({
      code: "RELIGHT_ENGINE_REQUIRED"
    });
    expect(boundary.capture).not.toHaveBeenCalled();
  });

  it("captures, generates, validates, applies and restores in order", async () => {
    const boundary = adapters();
    vi.mocked(boundary.prepare).mockResolvedValue("data:image/png;base64,cHJlcGFyZWQ=");
    const phases: string[] = [];
    const gemini = engine();
    const result = await executeRelightWorkflow(gemini, { ...task(), onPhase: (phase) => phases.push(phase) }, boundary);
    expect(phases).toEqual(["preparing", "generating", "applying"]);
    expect(gemini.generate).toHaveBeenCalledWith(expect.objectContaining({
      baseImageBase64: "c291cmNl",
      taskId: "relight-1"
    }));
    expect(boundary.prepare).toHaveBeenCalledWith("data:image/png;base64,cmVzdWx0", expect.any(AbortSignal));
    expect(boundary.apply).toHaveBeenCalledWith(source, "data:image/png;base64,cHJlcGFyZWQ=", 63, "relight-1", expect.any(Function));
    expect(boundary.restore).toHaveBeenCalledWith(source, "relight-1");
    expect(result.layerId).toBe(44);
    expect(result.image).toBe("data:image/png;base64,cHJlcGFyZWQ=");
  });

  it("does not apply after cancellation following generation", async () => {
    let current = true;
    const gemini = engine();
    vi.mocked(gemini.generate).mockImplementation(async () => {
      current = false;
      return { images: ["cmVzdWx0"] };
    });
    const boundary = adapters();
    await expect(executeRelightWorkflow(gemini, task(() => current), boundary)).rejects.toMatchObject({ code: "CANCELLED" });
    expect(boundary.apply).not.toHaveBeenCalled();
    expect(boundary.restore).toHaveBeenCalled();
  });

  it("does not validate or apply after cancellation during pixel preparation", async () => {
    const controller = new AbortController();
    const boundary = adapters();
    vi.mocked(boundary.prepare).mockImplementation(async (dataUrl) => {
      controller.abort();
      return dataUrl;
    });
    await expect(executeRelightWorkflow(engine(), {
      ...task(),
      signal: controller.signal
    }, boundary)).rejects.toMatchObject({ code: "CANCELLED" });
    expect(boundary.validate).not.toHaveBeenCalled();
    expect(boundary.apply).not.toHaveBeenCalled();
    expect(boundary.restore).toHaveBeenCalled();
  });

  it("rolls back the exact placed layer when cancellation races with placement", async () => {
    let current = true;
    const boundary = adapters();
    vi.mocked(boundary.apply).mockImplementation(async () => {
      current = false;
      return { layerId: 91 };
    });
    await expect(executeRelightWorkflow(engine(), task(() => current), boundary)).rejects.toMatchObject({ code: "CANCELLED" });
    expect(boundary.rollback).toHaveBeenCalledWith(source, 91, "relight-1");
  });

  it("rolls back a committed layer if context restoration fails", async () => {
    const boundary = adapters();
    vi.mocked(boundary.restore).mockRejectedValue(new Error("restore failed"));
    await expect(executeRelightWorkflow(engine(), task(), boundary)).rejects.toThrow("restore failed");
    expect(boundary.rollback).toHaveBeenCalledWith(source, 44, "relight-1");
  });

  it("rejects an empty engine result without applying", async () => {
    const gemini = engine();
    vi.mocked(gemini.generate).mockResolvedValue({ images: [] });
    const boundary = adapters();
    await expect(executeRelightWorkflow(gemini, task(), boundary)).rejects.toThrow("未返回图像");
    expect(boundary.apply).not.toHaveBeenCalled();
  });

  it("rejects an oversized energy layer before pixel decoding", async () => {
    const gemini = engine();
    vi.mocked(gemini.generate).mockResolvedValue({ images: ["A".repeat(RELIGHT_ENERGY_MAX_BASE64_LENGTH + 1)] });
    const boundary = adapters();
    await expect(executeRelightWorkflow(gemini, task(), boundary)).rejects.toThrow("超过安全内存预算");
    expect(boundary.prepare).not.toHaveBeenCalled();
    expect(boundary.apply).not.toHaveBeenCalled();
  });

  it("rejects an oversized re-encoded layer before Photoshop decoding", async () => {
    const boundary = adapters();
    vi.mocked(boundary.prepare).mockResolvedValue(
      `data:image/png;base64,${"A".repeat(RELIGHT_ENERGY_MAX_BASE64_LENGTH + 1)}`
    );
    await expect(executeRelightWorkflow(engine(), task(), boundary)).rejects.toThrow("超过安全内存预算");
    expect(boundary.apply).not.toHaveBeenCalled();
  });
});
