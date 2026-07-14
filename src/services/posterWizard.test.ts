import { describe, expect, it, vi } from "vitest";
import type { GenerationEngine } from "./generationEngine";
import {
  POSTER_FRAGMENT_TYPES,
  POSTER_PROMPT_FRAGMENTS,
  POSTER_SYSTEM_PROMPT,
  buildPosterPrompt,
  createDefaultPosterDraft,
  executePosterWorkflow
} from "./posterWizard";

const completeDraft = () => ({
  ...createDefaultPosterDraft(),
  subject: "夏日咖啡新品",
  title: "SUMMER DROP",
  subtitle: "七月限定风味",
  details: "主色使用明黄与深绿"
});

const createEngine = (provider: GenerationEngine["provider"] = "gemini") => ({
  provider,
  progressMode: provider === "gemini" ? "indeterminate" : "determinate",
  generate: vi.fn().mockResolvedValue({ images: ["POSTER_IMAGE"] }),
  cancel: vi.fn().mockReturnValue(false),
  cancelAll: vi.fn().mockReturnValue(0)
}) as unknown as GenerationEngine;

const createAdapters = () => ({
  placeImage: vi.fn().mockResolvedValue({ layerID: 42 }),
  groupLayers: vi.fn().mockResolvedValue(null),
  moveActiveLayerToTop: vi.fn().mockResolvedValue(undefined)
});

describe("poster wizard fragment library", () => {
  it("uses the extensible id-label-type-prompt tuple for every ordered step", () => {
    expect(POSTER_PROMPT_FRAGMENTS.length).toBeGreaterThanOrEqual(POSTER_FRAGMENT_TYPES.length * 3);
    expect(new Set(POSTER_PROMPT_FRAGMENTS.map(({ id }) => id)).size).toBe(POSTER_PROMPT_FRAGMENTS.length);
    for (const type of POSTER_FRAGMENT_TYPES) {
      expect(POSTER_PROMPT_FRAGMENTS.filter((fragment) => fragment.type === type).length).toBeGreaterThanOrEqual(3);
    }
    expect(POSTER_PROMPT_FRAGMENTS[0]).toEqual(expect.objectContaining({
      id: expect.any(String),
      label: expect.any(String),
      type: "theme",
      prompt: expect.any(String)
    }));
  });

  it("keeps fixed preservation constraints separate from editable user fragments", () => {
    const prompt = buildPosterPrompt(completeDraft());

    expect(prompt.systemPrompt).toBe(POSTER_SYSTEM_PROMPT);
    expect(prompt.systemPrompt).toContain("Preserve the source subject exactly");
    expect(prompt.userPrompt).toContain("SUMMER DROP");
    expect(prompt.userPrompt).toContain("七月限定风味");
    expect(prompt.userPrompt).not.toContain("Preserve the source subject exactly");
    expect(prompt.combinedPrompt).toBe(`${prompt.systemPrompt}\n\n${prompt.userPrompt}`);
    expect(prompt.aspectRatio).toBe("4:5");
  });

  it("rejects incomplete copy before any model request", () => {
    expect(() => buildPosterPrompt({ ...completeDraft(), title: "" })).toThrow("请输入海报主标题");
    expect(() => buildPosterPrompt({
      ...completeDraft(),
      selections: { ...completeDraft().selections, style: "missing" }
    })).toThrow("请选择有效的风格");
  });
});

describe("executePosterWorkflow", () => {
  it("routes a structured Gemini request through placement and returns Photoshop layer ids", async () => {
    const engine = createEngine();
    const adapters = createAdapters();

    const result = await executePosterWorkflow({
      engine,
      draft: completeDraft(),
      baseImageBase64: "SOURCE_IMAGE",
      timeoutMs: 30_000,
      feather: 12,
      taskId: "poster-1",
      adapters,
      isCurrent: () => true
    });

    expect(engine.generate).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining("SUMMER DROP"),
      systemPrompt: POSTER_SYSTEM_PROMPT,
      aspectRatio: "4:5",
      baseImageBase64: "SOURCE_IMAGE",
      taskId: "poster-1"
    }));
    expect(adapters.placeImage).toHaveBeenCalledWith(
      "data:image/png;base64,POSTER_IMAGE",
      1,
      { feather: 12, taskId: "poster-1" }
    );
    expect(adapters.moveActiveLayerToTop).toHaveBeenCalledWith({ layerId: 42, taskId: "poster-1" });
    expect(result.placedLayerIds).toEqual([42]);
  });

  it("rejects Forge before sending source pixels", async () => {
    const engine = createEngine("forge");
    const adapters = createAdapters();

    await expect(executePosterWorkflow({
      engine,
      draft: completeDraft(),
      baseImageBase64: "SOURCE_IMAGE",
      timeoutMs: 30_000,
      feather: 0,
      taskId: "poster-forge",
      adapters,
      isCurrent: () => true
    })).rejects.toMatchObject({ code: "POSTER_PROVIDER_REQUIRED" });

    expect(engine.generate).not.toHaveBeenCalled();
    expect(adapters.placeImage).not.toHaveBeenCalled();
  });

  it("does not place a late result after cancellation and still settles request hooks", async () => {
    let resolveImage!: (value: { images: string[] }) => void;
    let markRequestStarted!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      markRequestStarted = resolve;
    });
    const engine = createEngine();
    (engine.generate as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise((resolve) => {
      resolveImage = resolve;
      markRequestStarted();
    }));
    const adapters = createAdapters();
    let current = true;
    const onRequestSettled = vi.fn();
    const run = executePosterWorkflow({
      engine,
      draft: completeDraft(),
      baseImageBase64: "SOURCE_IMAGE",
      timeoutMs: 30_000,
      feather: 0,
      taskId: "poster-cancel",
      adapters,
      isCurrent: () => current,
      onRequestSettled
    });
    await requestStarted;

    current = false;
    resolveImage({ images: ["LATE_IMAGE"] });

    await expect(run).rejects.toMatchObject({ code: "ENGINE_STALE" });
    expect(adapters.placeImage).not.toHaveBeenCalled();
    expect(onRequestSettled).toHaveBeenCalledOnce();
  });

  it("does not paste anything when the model request fails", async () => {
    const engine = createEngine();
    (engine.generate as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("model offline"));
    const adapters = createAdapters();

    await expect(executePosterWorkflow({
      engine,
      draft: completeDraft(),
      baseImageBase64: "SOURCE_IMAGE",
      timeoutMs: 30_000,
      feather: 0,
      taskId: "poster-fail",
      adapters,
      isCurrent: () => true
    })).rejects.toThrow("model offline");
    expect(adapters.placeImage).not.toHaveBeenCalled();
  });
});
