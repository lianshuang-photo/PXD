import { describe, expect, it, vi } from "vitest";
import type { AppSettings } from "../context/types";
import type { Img2ImgParams } from "./apiClient";
import {
  createGenerationEngine,
  type EngineGenerateParams,
  type GenerationEngineFactories
} from "./generationEngine";
import {
  executeGenerationBatch,
  executeGenerationTask,
  type GenerationWorkflowAdapters,
  type GenerationWorkflowTask
} from "./generationWorkflow";
import { DEFAULT_SETTINGS } from "./settings";

const forgeParams: Img2ImgParams = {
  prompt: "edit",
  steps: 20,
  cfgScale: 7,
  batchSize: 1,
  width: 512,
  height: 512,
  denoisingStrength: 0.4,
  baseImage: "data:image/png;base64,INPUT"
};

const requestFor = (provider: AppSettings["imageProvider"], taskId?: string): EngineGenerateParams => ({
  prompt: "edit",
  baseImageBase64: "INPUT",
  timeoutMs: 30_000,
  taskId,
  forgeParams: provider === "forge" ? forgeParams : undefined
});

const makeHarness = (provider: AppSettings["imageProvider"], outputs: string[][]) => {
  const img2img = vi.fn();
  const editImage = vi.fn();
  for (const images of outputs) {
    if (provider === "forge") img2img.mockResolvedValueOnce({ images });
    else editImage.mockResolvedValueOnce(images[0]);
  }
  const factories = {
    createForgeClient: vi.fn().mockReturnValue({
      fetchOptions: vi.fn(),
      fetchProgress: vi.fn(),
      img2img
    }),
    createGeminiClient: vi.fn().mockReturnValue({ editImage })
  } as unknown as GenerationEngineFactories;
  const settings: AppSettings = {
    ...DEFAULT_SETTINGS,
    imageProvider: provider,
    offlineMode: provider === "forge",
    geminiApiKey: provider === "gemini" ? "key" : ""
  };
  const engine = createGenerationEngine(settings, factories);
  let nextLayerId = 100;
  const adapters: GenerationWorkflowAdapters = {
    placeImage: vi.fn().mockImplementation(async () => ({ layerID: nextLayerId++ })),
    groupLayers: vi.fn().mockResolvedValue(null),
    moveActiveLayerToTop: vi.fn().mockResolvedValue(undefined)
  };
  return { engine, adapters, img2img, editImage };
};

describe("generation workflow", () => {
  it.each(["forge", "gemini"] as const)(
    "executes one %s task through the shared request and placement workflow",
    async (provider) => {
      const harness = makeHarness(provider, [[`${provider}-one`, `${provider}-two`]]);
      const onRequestStart = vi.fn();
      const onRequestSettled = vi.fn();

      const result = await executeGenerationTask(
        harness.engine,
        {
          request: requestFor(provider),
          feather: 12,
          groupName: "single",
          emptyImagesMessage: "no image",
          onRequestStart,
          onRequestSettled
        },
        harness.adapters
      );

      const expectedImages = provider === "forge"
        ? [`${provider}-one`, `${provider}-two`]
        : [`${provider}-one`];
      expect(result.images).toEqual(expectedImages);
      expect(harness.adapters.placeImage).toHaveBeenNthCalledWith(
        1,
        `data:image/png;base64,${provider}-one`,
        1,
        { feather: 12 }
      );
      if (provider === "forge") {
        expect(harness.adapters.groupLayers).toHaveBeenCalledWith([100, 101], "single", {
          taskId: undefined
        });
      } else {
        expect(harness.adapters.groupLayers).not.toHaveBeenCalled();
      }
      expect(harness.adapters.moveActiveLayerToTop).toHaveBeenCalledOnce();
      expect(onRequestStart.mock.invocationCallOrder[0])
        .toBeLessThan(onRequestSettled.mock.invocationCallOrder[0]);
    }
  );

  it.each(["forge", "gemini"] as const)(
    "executes a %s batch through the production batch scheduler",
    async (provider) => {
      const harness = makeHarness(provider, [[`${provider}-one`], [`${provider}-two`]]);
      const prepareOne = vi.fn();
      const prepareTwo = vi.fn();
      const tasks: GenerationWorkflowTask[] = [
        {
          request: requestFor(provider, "task-1"),
          feather: 5,
          groupName: "one",
          emptyImagesMessage: "no image one",
          prepare: prepareOne
        },
        {
          request: requestFor(provider, "task-2"),
          feather: 8,
          groupName: "two",
          emptyImagesMessage: "no image two",
          prepare: prepareTwo
        }
      ];

      const results = await executeGenerationBatch(harness.engine, tasks, harness.adapters);

      expect(results.map(({ images }) => images)).toEqual([
        [`${provider}-one`],
        [`${provider}-two`]
      ]);
      expect(prepareOne.mock.invocationCallOrder[0])
        .toBeLessThan(prepareTwo.mock.invocationCallOrder[0]);
      expect(harness.adapters.placeImage).toHaveBeenCalledTimes(2);
      expect(harness.adapters.moveActiveLayerToTop).toHaveBeenCalledTimes(2);
      const clientCalls = provider === "forge" ? harness.img2img.mock.calls : harness.editImage.mock.calls;
      expect(clientCalls).toHaveLength(2);
    }
  );

  it("does not place a result after its engine generation becomes stale", async () => {
    const harness = makeHarness("gemini", [["stale-image"]]);
    let current = true;
    harness.editImage.mockReset().mockImplementationOnce(async () => {
      current = false;
      return "stale-image";
    });

    await expect(executeGenerationTask(
      harness.engine,
      {
        request: requestFor("gemini"),
        feather: 0,
        emptyImagesMessage: "no image",
        isCurrent: () => current
      },
      harness.adapters
    )).rejects.toMatchObject({ code: "ENGINE_STALE" });
    expect(harness.adapters.placeImage).not.toHaveBeenCalled();
  });

  it("reports a layer placed during a Photoshop modal before rejecting a cancelled run", async () => {
    const harness = makeHarness("gemini", [["poster"]]);
    let current = true;
    let resolvePlacement!: (value: { layerID: number }) => void;
    const placement = new Promise<{ layerID: number }>((resolve) => {
      resolvePlacement = resolve;
    });
    (harness.adapters.placeImage as ReturnType<typeof vi.fn>).mockReturnValueOnce(placement);
    const onLayerPlaced = vi.fn();

    const run = executeGenerationTask(
      harness.engine,
      {
        request: requestFor("gemini"),
        feather: 0,
        emptyImagesMessage: "no image",
        isCurrent: () => current,
        onLayerPlaced
      },
      harness.adapters
    );
    await vi.waitFor(() => expect(harness.adapters.placeImage).toHaveBeenCalledOnce());
    current = false;
    resolvePlacement({ layerID: 303 });

    await expect(run).rejects.toMatchObject({ code: "ENGINE_STALE" });
    expect(onLayerPlaced).toHaveBeenCalledWith(303);
  });

  it("reports a placed layer before a later move operation fails", async () => {
    const harness = makeHarness("gemini", [["poster"]]);
    const moveFailure = new Error("move failed");
    (harness.adapters.moveActiveLayerToTop as ReturnType<typeof vi.fn>).mockRejectedValueOnce(moveFailure);
    const onLayerPlaced = vi.fn();

    await expect(executeGenerationTask(
      harness.engine,
      {
        request: requestFor("gemini"),
        feather: 0,
        emptyImagesMessage: "no image",
        onLayerPlaced
      },
      harness.adapters
    )).rejects.toBe(moveFailure);

    expect(onLayerPlaced).toHaveBeenCalledWith(100);
    expect(onLayerPlaced.mock.invocationCallOrder[0])
      .toBeLessThan((harness.adapters.moveActiveLayerToTop as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]);
  });
});
