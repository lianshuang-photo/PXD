import { createElement, useCallback, useState, type Dispatch, type SetStateAction } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "../context/types";
import type { GenerationHistoryEntry } from "../services/generationHistory";
import { DEFAULT_SETTINGS } from "../services/settings";

const boundary = vi.hoisted(() => ({
  forgeClient: {
    fetchOptions: vi.fn(),
    fetchProgress: vi.fn(),
    img2img: vi.fn(),
    cancel: vi.fn().mockReturnValue(false),
    cancelAll: vi.fn().mockReturnValue(0)
  },
  geminiClient: {
    editImage: vi.fn(),
    cancel: vi.fn().mockReturnValue(false),
    cancelAll: vi.fn().mockReturnValue(0)
  },
  photoshop: {
    closeDocument: vi.fn(),
    closeGeneratedDocument: vi.fn(),
    createGeneratedDocument: vi.fn(),
    deleteLayersInDocument: vi.fn(),
    getDocumentPixels: vi.fn(),
    getSelectionMetadata: vi.fn(),
    placeImageIntoDocumentBounds: vi.fn(),
    getSelectionPixels: vi.fn(),
    groupLayers: vi.fn(),
    hasActiveSelection: vi.fn(),
    moveActiveLayerToTop: vi.fn(),
    onBatchAddLayer: vi.fn(),
    placeImageIntoSelection: vi.fn(),
    setSelectionBounds: vi.fn(),
    switchToDocument: vi.fn()
  },
  storage: {
    readJsonFile: vi.fn(),
    writeJsonFile: vi.fn()
  },
  thumbnailDecodeFails: false,
  listPresetMetas: vi.fn(),
  loadPresetFile: vi.fn(),
  savePresetFile: vi.fn(),
  deletePresetFile: vi.fn()
}));

vi.mock("../services/apiClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/apiClient")>()),
  createPxdClient: () => boundary.forgeClient
}));

vi.mock("../services/imageModelClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/imageModelClient")>()),
  createImageModelClient: () => boundary.geminiClient
}));

vi.mock("../services/photoshop", () => boundary.photoshop);

vi.mock("../services/presets", () => ({
  deletePresetFile: boundary.deletePresetFile,
  listPresetMetas: boundary.listPresetMetas,
  loadPresetFile: boundary.loadPresetFile,
  savePresetFile: boundary.savePresetFile
}));

vi.mock("../services/translator", () => ({
  translateText: vi.fn()
}));

vi.mock("../services/tileImage", () => ({
  featherTileDataUrl: vi.fn().mockResolvedValue("data:image/png;base64,FEATHERED")
}));

vi.mock("../services/uxpBridge", () => ({
  bridge: boundary.storage
}));

import {
  mapForgeDataToForm,
  useGenerationController,
  type GenerationControllerState,
  type GenerationForm
} from "./useGenerationController";
import { createDefaultPosterDraft } from "../services/posterWizard";

const emptyOptions = {
  models: [],
  vaes: [],
  loras: [],
  samplers: [],
  schedulers: [],
  controlNetModels: [],
  controlNetModules: []
};

const selection = (suffix: string) => ({
  dataUrl: `data:image/png;base64,INPUT${suffix}`,
  width: 640,
  height: 480,
  documentId: 7,
  selectionBounds: { left: 10, top: 20, right: 650, bottom: 500 }
});

const historyFile = (entries: GenerationHistoryEntry<GenerationForm>[] = []) => ({
  version: 1,
  entries
});

const customizeForm = (base: GenerationForm, prompt: string, offset: number): GenerationForm => ({
  ...base,
  positivePrompt: prompt,
  negativePrompt: `negative-${offset}`,
  extraPrompt: `extra-${offset}`,
  steps: 20 + offset,
  cfgScale: 7 + offset / 10,
  sampler: `sampler-${offset}`,
  scheduler: `scheduler-${offset}`,
  model: `model-${offset}`,
  vae: `vae-${offset}`,
  lora: `lora-${offset}`,
  loraWeight: 0.5 + offset / 10,
  controlNetModel: `control-model-${offset}`,
  controlNetModule: `control-module-${offset}`,
  controlNetWeight: 0.7 + offset / 10,
  denoisingStrength: 0.2 + offset / 100,
  maskFeather: 10 + offset,
  imageCount: 1,
  resolution: 768 + offset,
  seed: 1_000 + offset,
  clipSkip: offset,
  restoreFaces: offset % 2 === 0,
  tiling: offset % 2 === 1
});

const setCompleteForm = (controller: GenerationControllerState, next: GenerationForm) => {
  for (const key of Object.keys(next) as Array<keyof GenerationForm>) {
    controller.setFormValue(key, next[key]);
  }
};

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

interface HarnessOptions {
  initialSettings?: AppSettings;
  settingsLoading?: boolean;
  updateImpl?: (next: Pick<AppSettings, "imageProvider">) => Promise<void>;
}

const renderController = (options: HarnessOptions = {}) => {
  let controller: GenerationControllerState | null = null;
  let currentSettings = options.initialSettings ?? DEFAULT_SETTINGS;
  let setSettings: Dispatch<SetStateAction<AppSettings>> | null = null;
  const updateImpl = options.updateImpl ?? vi.fn().mockResolvedValue(undefined);
  const updateSettings = vi.fn(async (next: Pick<AppSettings, "imageProvider">) => {
    await updateImpl(next);
    (setSettings as Dispatch<SetStateAction<AppSettings>>)((current) => ({ ...current, ...next }));
  });

  const Harness = () => {
    const [settings, setSettingsState] = useState(currentSettings);
    setSettings = setSettingsState;
    currentSettings = settings;
    const patchSettings = useCallback(updateSettings, []);
    controller = useGenerationController(settings, {
      settingsLoading: options.settingsLoading,
      updateSettings: patchSettings
    });
    return null;
  };

  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(createElement(Harness));
  });
  return {
    renderer,
    updateSettings,
    getController: () => controller as unknown as GenerationControllerState,
    getSettings: () => currentSettings,
    setSettings: (next: SetStateAction<AppSettings>) => {
      (setSettings as Dispatch<SetStateAction<AppSettings>>)(next);
    }
  };
};

const renderers: TestRenderer.ReactTestRenderer[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  boundary.thumbnailDecodeFails = false;
  boundary.forgeClient.fetchOptions.mockResolvedValue(emptyOptions);
  boundary.forgeClient.fetchProgress.mockResolvedValue(null);
  boundary.forgeClient.img2img.mockResolvedValue({ images: ["FORGE_RESULT"] });
  boundary.geminiClient.editImage.mockResolvedValue("GEMINI_RESULT");
  boundary.photoshop.getSelectionPixels.mockResolvedValue(selection(""));
  boundary.photoshop.deleteLayersInDocument.mockResolvedValue(undefined);
  boundary.photoshop.getSelectionMetadata.mockResolvedValue({
    documentId: 7,
    width: 1024,
    height: 1024,
    selectionBounds: { left: 10, top: 20, right: 1034, bottom: 1044 }
  });
  boundary.photoshop.getDocumentPixels.mockResolvedValue("data:image/png;base64,TILE");
  boundary.photoshop.createGeneratedDocument.mockResolvedValue({ documentId: 9, previousDocumentId: 7 });
  boundary.photoshop.placeImageIntoDocumentBounds.mockResolvedValue({ layerID: 501 });
  boundary.photoshop.closeGeneratedDocument.mockResolvedValue(undefined);
  boundary.photoshop.hasActiveSelection.mockResolvedValue(true);
  boundary.photoshop.placeImageIntoSelection.mockResolvedValue({ layerID: 101 });
  boundary.photoshop.groupLayers.mockResolvedValue(undefined);
  boundary.photoshop.moveActiveLayerToTop.mockResolvedValue(undefined);
  boundary.photoshop.onBatchAddLayer.mockResolvedValue(null);
  boundary.photoshop.setSelectionBounds.mockResolvedValue(undefined);
  boundary.photoshop.switchToDocument.mockResolvedValue(undefined);
  boundary.storage.readJsonFile.mockResolvedValue(historyFile());
  boundary.storage.writeJsonFile.mockResolvedValue(undefined);

  class FakeImage {
    naturalWidth = 1024;
    naturalHeight = 768;
    width = 1024;
    height = 768;
    onload: null | (() => void) = null;
    onerror: null | (() => void) = null;

    set src(_value: string) {
      queueMicrotask(() => {
        if (boundary.thumbnailDecodeFails) this.onerror?.();
        else this.onload?.();
      });
    }
  }
  vi.stubGlobal("Image", FakeImage);
  vi.stubGlobal("document", {
    createElement: vi.fn().mockReturnValue({
      width: 0,
      height: 0,
      getContext: vi.fn().mockReturnValue({ clearRect: vi.fn(), drawImage: vi.fn() }),
      toDataURL: vi.fn().mockReturnValue("data:image/jpeg;base64,THUMB")
    })
  });
  vi.stubGlobal("window", {
    setInterval,
    clearInterval
  });
  boundary.listPresetMetas.mockResolvedValue([]);
  boundary.loadPresetFile.mockResolvedValue(null);
  boundary.savePresetFile.mockResolvedValue({
    meta: {
      name: "saved",
      fileName: "saved.json",
      createdAt: "",
      kind: "forge",
      isFactory: false
    },
    preset: { kind: "forge", title: "saved", data: {} },
    version: 2
  });
  boundary.deletePresetFile.mockResolvedValue(undefined);
});

afterEach(() => {
  for (const renderer of renderers.splice(0)) {
    act(() => renderer.unmount());
  }
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const trackedRender = (options: HarnessOptions = {}) => {
  const rendered = renderController(options);
  renderers.push(rendered.renderer);
  return rendered;
};

const completePosterDraft = () => ({
  ...createDefaultPosterDraft(),
  subject: "夏日咖啡新品",
  title: "SUMMER DROP",
  subtitle: "七月限定风味",
  details: "明黄与深绿"
});

describe("useGenerationController poster wizard", () => {
  const geminiSettings = {
    ...DEFAULT_SETTINGS,
    imageProvider: "gemini" as const,
    offlineMode: false
  };

  it("generates with separate preservation instructions, records history, and retains layer ids", async () => {
    boundary.photoshop.placeImageIntoSelection.mockResolvedValueOnce({ layerID: 404 });
    const rendered = trackedRender({ initialSettings: geminiSettings });
    await flush();

    let succeeded = false;
    await act(async () => {
      succeeded = await rendered.getController().runPosterWizard(completePosterDraft());
    });

    expect(succeeded).toBe(true);
    expect(boundary.geminiClient.editImage).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining("SUMMER DROP"),
      systemPrompt: expect.stringContaining("Preserve the source subject exactly"),
      aspectRatio: "4:5",
      baseImageBase64: "INPUT"
    }));
    const request = boundary.geminiClient.editImage.mock.calls[0][0];
    expect(request.prompt).not.toContain("Preserve the source subject exactly");
    expect(boundary.photoshop.placeImageIntoSelection).toHaveBeenCalledWith(
      "data:image/png;base64,GEMINI_RESULT",
      1,
      expect.objectContaining({ taskId: expect.any(String) })
    );
    expect(boundary.photoshop.switchToDocument).toHaveBeenCalledWith(7, {
      taskId: expect.any(String)
    });
    expect(rendered.getController().posterLastResult?.placedLayerIds).toEqual([404]);
    expect(rendered.getController().posterLastResult?.documentId).toBe(7);
    expect(rendered.getController().history[0]).toMatchObject({
      provider: "gemini",
      prompt: expect.stringContaining("SUMMER DROP")
    });
    expect(rendered.getController().posterRunning).toBe(false);
  });

  it("ignores a late model result after cancellation", async () => {
    let resolveImage!: (value: string) => void;
    boundary.geminiClient.editImage.mockImplementationOnce(() => new Promise((resolve) => {
      resolveImage = resolve;
    }));
    const rendered = trackedRender({ initialSettings: geminiSettings });
    await flush();

    let generation!: Promise<boolean>;
    act(() => {
      generation = rendered.getController().runPosterWizard(completePosterDraft());
    });
    await flush();
    act(() => rendered.getController().stopGeneration());
    resolveImage("LATE_POSTER");
    await act(async () => {
      await generation;
    });

    expect(boundary.photoshop.placeImageIntoSelection).not.toHaveBeenCalled();
    expect(rendered.getController().posterRunning).toBe(false);
    expect(rendered.getController().posterLastResult).toBeNull();
  });

  it("keeps failures actionable and does not expose undo state", async () => {
    boundary.geminiClient.editImage.mockRejectedValueOnce(new Error("model offline"));
    const rendered = trackedRender({ initialSettings: geminiSettings });
    await flush();

    await act(async () => {
      await rendered.getController().runPosterWizard(completePosterDraft());
    });

    expect(rendered.getController().status).toBe("error");
    expect(rendered.getController().error).toContain("model offline");
    expect(rendered.getController().posterLastResult).toBeNull();
    expect(boundary.photoshop.placeImageIntoSelection).not.toHaveBeenCalled();
  });

  it("keeps the previous undo result until a new attempt actually places a layer", async () => {
    boundary.photoshop.placeImageIntoSelection.mockResolvedValueOnce({ layerID: 411 });
    const rendered = trackedRender({ initialSettings: geminiSettings });
    await flush();
    await act(async () => {
      await rendered.getController().runPosterWizard(completePosterDraft());
    });
    const previous = rendered.getController().posterLastResult;

    boundary.photoshop.getSelectionPixels.mockResolvedValueOnce(null);
    await act(async () => {
      await rendered.getController().runPosterWizard(completePosterDraft());
    });
    expect(rendered.getController().posterLastResult).toEqual(previous);

    boundary.geminiClient.editImage.mockRejectedValueOnce(new Error("model failed"));
    await act(async () => {
      await rendered.getController().runPosterWizard(completePosterDraft());
    });
    expect(rendered.getController().posterLastResult).toEqual(previous);

    let resolveImage!: (value: string) => void;
    boundary.geminiClient.editImage.mockImplementationOnce(() => new Promise((resolve) => {
      resolveImage = resolve;
    }));
    let cancelledRun!: Promise<boolean>;
    act(() => {
      cancelledRun = rendered.getController().runPosterWizard(completePosterDraft());
    });
    await vi.waitFor(() => expect(boundary.geminiClient.editImage).toHaveBeenCalledTimes(3));
    act(() => rendered.getController().stopGeneration());
    resolveImage("LATE_POSTER");
    await act(async () => {
      await cancelledRun;
    });

    expect(rendered.getController().posterLastResult).toEqual(previous);
  });

  it("tracks a layer that finishes placing after cancellation during the Photoshop modal", async () => {
    let rejectPlacement!: (reason: unknown) => void;
    boundary.photoshop.placeImageIntoSelection.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      rejectPlacement = reject;
    }));
    const rendered = trackedRender({ initialSettings: geminiSettings });
    await flush();

    let generation!: Promise<boolean>;
    act(() => {
      generation = rendered.getController().runPosterWizard(completePosterDraft());
    });
    await vi.waitFor(() => expect(boundary.photoshop.placeImageIntoSelection).toHaveBeenCalledOnce());
    act(() => rendered.getController().stopGeneration());
    rejectPlacement(Object.assign(new Error("selection restore failed"), {
      placedLayerId: 616
    }));
    await act(async () => {
      await generation;
    });

    expect(rendered.getController().posterLastResult).toMatchObject({
      documentId: 7,
      placedLayerIds: [616]
    });
    expect(rendered.getController().posterRunning).toBe(false);

    const taskId = rendered.getController().posterLastResult?.taskId;
    await act(async () => rendered.getController().undoPosterGeneration());
    expect(boundary.photoshop.deleteLayersInDocument).toHaveBeenCalledWith(7, [616], { taskId });
    expect(rendered.getController().posterLastResult).toBeNull();
  });

  it("retains the placed layer when a later move operation fails", async () => {
    boundary.photoshop.placeImageIntoSelection.mockResolvedValueOnce({ layerID: 717 });
    boundary.photoshop.moveActiveLayerToTop.mockRejectedValueOnce(new Error("move failed"));
    const rendered = trackedRender({ initialSettings: geminiSettings });
    await flush();

    await act(async () => {
      await rendered.getController().runPosterWizard(completePosterDraft());
    });

    expect(rendered.getController().status).toBe("error");
    expect(rendered.getController().posterLastResult).toMatchObject({
      documentId: 7,
      placedLayerIds: [717]
    });
  });

  it("deletes exactly the generated layers and retains undo state when Photoshop fails", async () => {
    boundary.photoshop.placeImageIntoSelection.mockResolvedValueOnce({ layerID: 515 });
    const rendered = trackedRender({ initialSettings: geminiSettings });
    await flush();
    await act(async () => {
      await rendered.getController().runPosterWizard(completePosterDraft());
    });
    const taskId = rendered.getController().posterLastResult?.taskId;

    boundary.photoshop.deleteLayersInDocument.mockRejectedValueOnce(new Error("locked"));
    await act(async () => rendered.getController().undoPosterGeneration());
    expect(rendered.getController().posterLastResult?.placedLayerIds).toEqual([515]);

    await act(async () => rendered.getController().undoPosterGeneration());
    expect(boundary.photoshop.deleteLayersInDocument).toHaveBeenLastCalledWith(7, [515], { taskId });
    expect(rendered.getController().posterLastResult).toBeNull();
  });
});

const tiledConfig = {
  scale: 2 as const,
  tileSize: 1024,
  overlap: 256,
  feather: 128,
  edgeMode: "anchor" as const,
  prompt: "enhance texture"
};

describe("useGenerationController tiled upscale", () => {
  it("runs Gemini tiles into a grouped non-destructive output", async () => {
    boundary.photoshop.groupLayers.mockResolvedValueOnce(700);
    const rendered = trackedRender({
      initialSettings: { ...DEFAULT_SETTINGS, imageProvider: "gemini", offlineMode: false }
    });
    await flush();

    await act(async () => {
      await rendered.getController().runTiledUpscale(tiledConfig);
    });

    expect(boundary.geminiClient.editImage).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining("Preserve the exact composition"),
      baseImageBase64: "TILE",
      taskId: expect.stringContaining("tile-0-0")
    }));
    expect(boundary.photoshop.placeImageIntoDocumentBounds).toHaveBeenCalledWith(
      "data:image/png;base64,FEATHERED",
      { left: 0, top: 0, right: 2048, bottom: 2048 },
      1,
      9,
      expect.objectContaining({ taskId: expect.any(String) })
    );
    expect(boundary.photoshop.groupLayers).toHaveBeenCalledWith([501], "PXD 分块放大", expect.objectContaining({
      requireGroup: true
    }));
    expect(rendered.getController().status).toBe("success");
    expect(rendered.getController().tiledUpscaleRunning).toBe(false);
  });

  it("maps Forge tiles to img2img dimensions and current generation controls", async () => {
    const rendered = trackedRender();
    await flush();

    await act(async () => {
      await rendered.getController().runTiledUpscale({ ...tiledConfig, tileSize: 768, overlap: 192, feather: 96 });
    });

    expect(boundary.forgeClient.img2img).toHaveBeenCalledWith(expect.objectContaining({
      baseImage: "data:image/png;base64,TILE",
      width: 1536,
      height: 1536,
      prompt: expect.stringContaining("enhance texture"),
      denoisingStrength: rendered.getController().form.denoisingStrength
    }), expect.objectContaining({ taskId: expect.stringContaining("tile-0-0") }));
    expect(boundary.forgeClient.img2img.mock.calls[0][0].prompt).toContain("Preserve the exact composition");
  });

  it("cancels a late tile, closes the output, and restores the source document", async () => {
    let resolveImage!: (value: string) => void;
    boundary.geminiClient.editImage.mockImplementationOnce(() => new Promise((resolve) => {
      resolveImage = resolve;
    }));
    const rendered = trackedRender({
      initialSettings: { ...DEFAULT_SETTINGS, imageProvider: "gemini", offlineMode: false }
    });
    await flush();

    let run!: Promise<boolean>;
    act(() => {
      run = rendered.getController().runTiledUpscale(tiledConfig);
    });
    await vi.waitFor(() => expect(boundary.geminiClient.editImage).toHaveBeenCalledOnce());
    act(() => rendered.getController().stopGeneration());
    resolveImage("LATE");
    await act(async () => {
      await run;
    });

    expect(boundary.photoshop.placeImageIntoDocumentBounds).not.toHaveBeenCalled();
    expect(boundary.photoshop.closeGeneratedDocument).toHaveBeenCalledWith(
      9,
      7,
      expect.objectContaining({ taskId: expect.any(String) })
    );
    expect(rendered.getController().status).toBe("idle");
  });

  it("blocks a new run until the stopped tiled workflow has finished rolling back", async () => {
    let resolveImage!: (value: string) => void;
    boundary.geminiClient.editImage.mockImplementationOnce(() => new Promise((resolve) => {
      resolveImage = resolve;
    }));
    const rendered = trackedRender({
      initialSettings: { ...DEFAULT_SETTINGS, imageProvider: "gemini", offlineMode: false }
    });
    await flush();

    let oldRun!: Promise<boolean>;
    act(() => {
      oldRun = rendered.getController().runTiledUpscale(tiledConfig);
    });
    await vi.waitFor(() => expect(boundary.geminiClient.editImage).toHaveBeenCalledOnce());
    act(() => rendered.getController().stopGeneration());

    expect(rendered.getController().tiledUpscaleStopping).toBe(true);
    expect(rendered.getController().tiledUpscaleRunning).toBe(true);
    await act(async () => {
      await rendered.getController().runGeneration();
    });
    expect(boundary.photoshop.getSelectionPixels).not.toHaveBeenCalled();
    let blockedResult!: boolean;
    await act(async () => {
      blockedResult = await rendered.getController().runTiledUpscale(tiledConfig);
    });
    expect(blockedResult).toBe(false);
    expect(boundary.photoshop.createGeneratedDocument).toHaveBeenCalledOnce();
    expect(boundary.photoshop.getSelectionMetadata).toHaveBeenCalledOnce();

    resolveImage("LATE");
    await act(async () => {
      await oldRun;
    });
    expect(boundary.photoshop.closeGeneratedDocument).toHaveBeenCalledOnce();
    expect(rendered.getController().tiledUpscaleStopping).toBe(false);
    expect(rendered.getController().status).toBe("idle");

    await act(async () => {
      expect(await rendered.getController().runTiledUpscale(tiledConfig)).toBe(true);
    });
    expect(boundary.photoshop.createGeneratedDocument).toHaveBeenCalledTimes(2);
  });

  it("surfaces output recovery failure even after cancellation invalidates the run", async () => {
    let resolveImage!: (value: string) => void;
    boundary.geminiClient.editImage.mockImplementationOnce(() => new Promise((resolve) => {
      resolveImage = resolve;
    }));
    boundary.photoshop.closeGeneratedDocument.mockRejectedValueOnce(new Error("close failed"));
    const rendered = trackedRender({
      initialSettings: { ...DEFAULT_SETTINGS, imageProvider: "gemini", offlineMode: false }
    });
    await flush();

    let run!: Promise<boolean>;
    act(() => {
      run = rendered.getController().runTiledUpscale(tiledConfig);
    });
    await vi.waitFor(() => expect(boundary.geminiClient.editImage).toHaveBeenCalledOnce());
    act(() => rendered.getController().stopGeneration());
    resolveImage("LATE");
    await act(async () => {
      await run;
    });

    expect(rendered.getController().status).toBe("error");
    expect(rendered.getController().error).toContain("输出文档恢复失败");
    expect(rendered.getController().error).toContain("close failed");
  });
});

describe("useGenerationController generation history integration", () => {
  it("records a single generation and restores its provider and complete form", async () => {
    const rendered = trackedRender();
    await flush();
    const expected = customizeForm(rendered.getController().form, "single prompt", 3);
    act(() => setCompleteForm(rendered.getController(), expected));

    await act(async () => {
      await rendered.getController().runGeneration();
    });

    expect({ status: rendered.getController().status, error: rendered.getController().error })
      .toEqual({ status: "success", error: null });
    const recorded = rendered.getController().history[0];
    expect(recorded).toMatchObject({
      provider: "forge",
      prompt: "single prompt\nextra-3",
      params: expected,
      thumbnailDataUrl: "data:image/jpeg;base64,THUMB"
    });
    expect({ status: rendered.getController().status, error: rendered.getController().error })
      .toEqual({ status: "success", error: null });
    expect(boundary.storage.writeJsonFile).toHaveBeenCalledWith(
      "generation-history.json",
      expect.objectContaining({ entries: expect.arrayContaining([expect.objectContaining({ id: recorded.id })]) })
    );

    act(() => {
      rendered.setSettings((current) => ({ ...current, imageProvider: "gemini", offlineMode: false }));
      setCompleteForm(rendered.getController(), customizeForm(expected, "changed", 8));
    });
    await act(async () => {
      await rendered.getController().restoreHistoryConfig(recorded.id);
    });

    expect(rendered.updateSettings).toHaveBeenCalledWith({ imageProvider: "forge" });
    expect(rendered.getSettings().imageProvider).toBe("forge");
    expect(rendered.getController().form).toEqual(expected);
  });

  it("records every successful batch task with its own complete parameters", async () => {
    boundary.photoshop.getSelectionPixels
      .mockResolvedValueOnce(selection("ONE"))
      .mockResolvedValueOnce(selection("TWO"));
    boundary.forgeClient.img2img
      .mockResolvedValueOnce({ images: ["BATCH_ONE"] })
      .mockResolvedValueOnce({ images: ["BATCH_TWO"] });
    const rendered = trackedRender();
    await flush();
    const first = customizeForm(rendered.getController().form, "batch one", 1);
    const second = customizeForm(rendered.getController().form, "batch two", 2);
    act(() => setCompleteForm(rendered.getController(), first));
    await act(async () => rendered.getController().addToBatch());
    act(() => setCompleteForm(rendered.getController(), second));
    await act(async () => rendered.getController().addToBatch());

    await act(async () => rendered.getController().runBatch());

    expect(rendered.getController().status).toBe("success");
    expect(rendered.getController().batchItems.map((item) => item.status)).toEqual(["success", "success"]);
    expect(rendered.getController().history).toHaveLength(2);
    expect(rendered.getController().history.map(({ params }) => params)).toEqual([second, first]);
    expect(boundary.storage.writeJsonFile).toHaveBeenCalledTimes(2);
  });

  it("validates the current selection before replaying a persisted thumbnail", async () => {
    const params = customizeForm({} as GenerationForm, "replay", 4);
    const persisted: GenerationHistoryEntry<GenerationForm> = {
      id: "replay-entry",
      ts: 2_000,
      provider: "forge",
      prompt: "replay",
      params,
      thumbnailDataUrl: "data:image/jpeg;base64,REPLAY"
    };
    boundary.storage.readJsonFile.mockResolvedValue(historyFile([persisted]));
    const rendered = trackedRender();
    await flush();

    boundary.photoshop.hasActiveSelection.mockResolvedValueOnce(false);
    await act(async () => rendered.getController().pasteHistoryResult(persisted.id));
    expect(boundary.photoshop.placeImageIntoSelection).not.toHaveBeenCalled();
    expect(rendered.getController().toast).toMatchObject({ type: "warning" });

    boundary.photoshop.hasActiveSelection.mockResolvedValueOnce(true);
    await act(async () => rendered.getController().pasteHistoryResult(persisted.id));
    expect(boundary.photoshop.placeImageIntoSelection).toHaveBeenCalledWith(
      persisted.thumbnailDataUrl,
      1,
      { feather: params.maskFeather }
    );
    expect(boundary.photoshop.moveActiveLayerToTop).toHaveBeenCalledOnce();
  });

  it.each(["thumbnail", "write"] as const)(
    "keeps generation successful when history %s processing fails",
    async (failure) => {
      if (failure === "thumbnail") boundary.thumbnailDecodeFails = true;
      else boundary.storage.writeJsonFile.mockRejectedValueOnce(new Error("disk full"));
      const rendered = trackedRender();
      await flush();

      await act(async () => rendered.getController().runGeneration());

      expect({ status: rendered.getController().status, error: rendered.getController().error })
        .toEqual({ status: "success", error: null });
      expect(rendered.getController().historyError).toContain(
        failure === "thumbnail" ? "缩略图创建失败" : "保存失败"
      );
      expect(rendered.getController().toast).toMatchObject({ type: "warning" });
      if (failure === "write") expect(rendered.getController().history).toHaveLength(1);
    }
  );

  it.each(["thumbnail", "write"] as const)(
    "keeps a completed batch successful when history %s processing fails",
    async (failure) => {
      const rendered = trackedRender();
      await flush();
      act(() => setCompleteForm(
        rendered.getController(),
        customizeForm(rendered.getController().form, "batch fallback", 6)
      ));
      await act(async () => rendered.getController().addToBatch());
      if (failure === "thumbnail") boundary.thumbnailDecodeFails = true;
      else boundary.storage.writeJsonFile.mockRejectedValueOnce(new Error("disk full"));

      await act(async () => rendered.getController().runBatch());

      expect({ status: rendered.getController().status, error: rendered.getController().error })
        .toEqual({ status: "success", error: null });
      expect(rendered.getController().batchItems.every((item) => item.status === "success")).toBe(true);
      expect(rendered.getController().toast).toMatchObject({ type: "warning" });
    }
  );
});

describe("useGenerationController history provider restoration", () => {
  const persistedEntry = (id: string, provider: AppSettings["imageProvider"], prompt: string, offset: number) => ({
    id,
    ts: 3_000 + offset,
    provider,
    prompt,
    params: customizeForm({} as GenerationForm, prompt, offset),
    thumbnailDataUrl: "data:image/jpeg;base64,HISTORY"
  });

  it("blocks provider restoration while settings are still loading", async () => {
    const entry = persistedEntry("loading", "gemini", "loading", 1);
    boundary.storage.readJsonFile.mockResolvedValue(historyFile([entry]));
    const rendered = trackedRender({ settingsLoading: true });
    await flush();
    const before = rendered.getController().form;

    await act(async () => rendered.getController().restoreHistoryConfig(entry.id));

    expect(rendered.updateSettings).not.toHaveBeenCalled();
    expect(rendered.getController().form).toBe(before);
    expect(rendered.getController().toast).toMatchObject({ type: "warning" });
  });

  it("keeps the current form and provider when the settings patch fails", async () => {
    const entry = persistedEntry("failure", "gemini", "failure", 2);
    boundary.storage.readJsonFile.mockResolvedValue(historyFile([entry]));
    const rendered = trackedRender({
      updateImpl: vi.fn().mockRejectedValue(new Error("settings disk full"))
    });
    await flush();
    const before = rendered.getController().form;

    await act(async () => rendered.getController().restoreHistoryConfig(entry.id));

    expect(rendered.getSettings().imageProvider).toBe("forge");
    expect(rendered.getController().form).toBe(before);
    expect(rendered.getController().toast).toMatchObject({
      type: "error",
      message: expect.stringContaining("settings disk full")
    });
  });

  it("serializes rapid provider restores so the latest request wins", async () => {
    const gemini = persistedEntry("gemini", "gemini", "gemini form", 3);
    const forge = persistedEntry("forge", "forge", "forge form", 4);
    boundary.storage.readJsonFile.mockResolvedValue(historyFile([gemini, forge]));
    let releaseFirst!: () => void;
    const firstPatch = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const updateImpl = vi.fn()
      .mockImplementationOnce(() => firstPatch)
      .mockResolvedValueOnce(undefined);
    const rendered = trackedRender({ updateImpl });
    await flush();

    let firstRestore!: Promise<void>;
    act(() => {
      firstRestore = rendered.getController().restoreHistoryConfig(gemini.id);
    });
    await flush();
    let latestRestore!: Promise<void>;
    act(() => {
      latestRestore = rendered.getController().restoreHistoryConfig(forge.id);
    });
    await act(async () => {
      releaseFirst();
      await firstRestore;
      await latestRestore;
    });

    expect(updateImpl.mock.calls).toEqual([
      [{ imageProvider: "gemini" }],
      [{ imageProvider: "forge" }]
    ]);
    expect(rendered.getSettings().imageProvider).toBe("forge");
    expect(rendered.getController().form).toEqual(forge.params);
  });
});

describe("useGenerationController preset schemas", () => {
  it("maps only valid Forge fields onto complete defaults", () => {
    const mapped = mapForgeDataToForm({
      positivePrompt: "restored",
      steps: 34,
      cfgScale: Number.NaN,
      tiling: true,
      unknown: "ignored"
    });

    expect(mapped).toMatchObject({
      positivePrompt: "restored",
      steps: 34,
      cfgScale: 7,
      tiling: true,
      resolution: 768
    });
    expect(mapped).not.toHaveProperty("unknown");
  });

  it("switches provider before applying a Gemini factory prompt", async () => {
    boundary.loadPresetFile.mockResolvedValueOnce({
      meta: {
        name: "自然光",
        fileName: "factory:natural.json",
        createdAt: "",
        kind: "gemini",
        isFactory: true
      },
      preset: { kind: "gemini", title: "自然光", content: "natural relight" },
      version: 2
    });
    const rendered = trackedRender();
    await flush();

    await act(async () => rendered.getController().applyPreset("factory:natural.json"));

    expect(rendered.updateSettings).toHaveBeenCalledWith({ imageProvider: "gemini" });
    expect(rendered.getController().form.positivePrompt).toBe("natural relight");
    expect(rendered.getController().form.extraPrompt).toBe("");
    expect(rendered.getController().selectedPreset).toBe("factory:natural.json");
  });

  it("keeps the form unchanged when the Gemini provider patch fails", async () => {
    boundary.loadPresetFile.mockResolvedValueOnce({
      meta: { name: "失败", fileName: "factory:failed.json", createdAt: "", kind: "gemini", isFactory: true },
      preset: { kind: "gemini", title: "失败", content: "must not apply" },
      version: 2
    });
    const rendered = trackedRender({
      updateImpl: vi.fn().mockRejectedValue(new Error("settings write failed"))
    });
    await flush();
    const before = rendered.getController().form;
    let caught: unknown;

    await act(async () => {
      caught = await rendered.getController().applyPreset("factory:failed.json").catch((error) => error);
    });

    expect(caught).toBeInstanceOf(Error);
    expect(rendered.getController().form).toBe(before);
    expect(rendered.getController().selectedPreset).toBeNull();
  });

  it("switches from Gemini to Forge before restoring Forge fields", async () => {
    boundary.loadPresetFile.mockResolvedValueOnce({
      meta: { name: "重绘", fileName: "factory:redraw.json", createdAt: "", kind: "forge", isFactory: true },
      preset: {
        kind: "forge",
        title: "重绘",
        data: { positivePrompt: "forge prompt", steps: 31, restoreFaces: true }
      },
      version: 2
    });
    const rendered = trackedRender({
      initialSettings: {
        ...DEFAULT_SETTINGS,
        imageProvider: "gemini",
        offlineMode: false,
        geminiApiKey: "key"
      }
    });
    await flush();

    await act(async () => rendered.getController().applyPreset("factory:redraw.json"));

    expect(rendered.updateSettings).toHaveBeenCalledWith({ imageProvider: "forge" });
    expect(rendered.getSettings().imageProvider).toBe("forge");
    expect(rendered.getController().form).toMatchObject({
      positivePrompt: "forge prompt",
      steps: 31,
      restoreFaces: true,
      cfgScale: 7
    });
  });

  it("serializes rapid preset applications so the latest provider and form win", async () => {
    const geminiPreset = {
      meta: { name: "Gemini", fileName: "factory:gemini.json", createdAt: "", kind: "gemini", isFactory: true },
      preset: { kind: "gemini", title: "Gemini", content: "stale prompt" },
      version: 2
    } as const;
    const forgePreset = {
      meta: { name: "Forge", fileName: "factory:forge.json", createdAt: "", kind: "forge", isFactory: true },
      preset: { kind: "forge", title: "Forge", data: { positivePrompt: "latest prompt", steps: 42 } },
      version: 2
    } as const;
    boundary.loadPresetFile
      .mockResolvedValueOnce(geminiPreset)
      .mockResolvedValueOnce(forgePreset);
    let releaseFirst!: () => void;
    const firstPatch = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const updateImpl = vi.fn()
      .mockImplementationOnce(() => firstPatch)
      .mockResolvedValueOnce(undefined);
    const rendered = trackedRender({ updateImpl });
    await flush();

    let first!: Promise<void>;
    act(() => {
      first = rendered.getController().applyPreset(geminiPreset.meta.fileName);
    });
    await flush();
    let second!: Promise<void>;
    act(() => {
      second = rendered.getController().applyPreset(forgePreset.meta.fileName);
    });
    await act(async () => {
      releaseFirst();
      await Promise.all([first, second]);
    });

    expect(updateImpl.mock.calls).toEqual([
      [{ imageProvider: "gemini" }],
      [{ imageProvider: "forge" }]
    ]);
    expect(rendered.getSettings().imageProvider).toBe("forge");
    expect(rendered.getController().form).toMatchObject({ positivePrompt: "latest prompt", steps: 42 });
    expect(rendered.getController().selectedPreset).toBe(forgePreset.meta.fileName);
  });

  it("saves the current provider schema and rejects factory deletion", async () => {
    const factoryMeta = {
      name: "出厂",
      fileName: "factory:readonly.json",
      createdAt: "",
      kind: "gemini" as const,
      category: "智能修图",
      isFactory: true
    };
    boundary.listPresetMetas.mockResolvedValue([factoryMeta]);
    boundary.savePresetFile.mockResolvedValueOnce({
      meta: { ...factoryMeta, name: "我的版本", fileName: "我的版本.json", isFactory: false },
      preset: { kind: "gemini", title: "我的版本", content: "prompt\nextra" },
      version: 2
    });
    const rendered = trackedRender({
      initialSettings: {
        ...DEFAULT_SETTINGS,
        imageProvider: "gemini",
        offlineMode: false,
        geminiApiKey: "key"
      }
    });
    await flush();
    act(() => {
      rendered.getController().setSelectedPreset(factoryMeta.fileName);
      rendered.getController().setFormValue("positivePrompt", "prompt");
      rendered.getController().setFormValue("extraPrompt", "extra");
    });

    await act(async () => rendered.getController().savePreset("我的版本"));
    expect(boundary.savePresetFile).toHaveBeenCalledWith(
      "我的版本",
      expect.objectContaining({
        kind: "gemini",
        category: "智能修图",
        content: "prompt\nextra"
      })
    );

    act(() => rendered.getController().setSelectedPreset(factoryMeta.fileName));
    let caught: unknown;
    await act(async () => {
      caught = await rendered.getController().deletePreset(factoryMeta.fileName).catch((error) => error);
    });
    expect(caught).toBeInstanceOf(Error);
    expect(boundary.deletePresetFile).not.toHaveBeenCalled();
  });

  it("preserves the selected user file name when overwriting a custom title", async () => {
    const userMeta = {
      name: "自定义标题",
      fileName: "legacy.json",
      createdAt: "",
      kind: "forge" as const,
      category: "用户预设",
      isFactory: false
    };
    boundary.listPresetMetas.mockResolvedValue([userMeta]);
    boundary.savePresetFile.mockResolvedValueOnce({
      meta: userMeta,
      preset: { kind: "forge", title: userMeta.name, data: {} },
      version: 2
    });
    const rendered = trackedRender();
    await flush();
    act(() => rendered.getController().setSelectedPreset(userMeta.fileName));

    await act(async () => rendered.getController().savePreset(userMeta.name, userMeta.fileName));

    expect(boundary.savePresetFile).toHaveBeenCalledWith(
      userMeta.name,
      expect.objectContaining({ kind: "forge", title: userMeta.name }),
      { targetFileName: userMeta.fileName }
    );
    expect(rendered.getController().selectedPreset).toBe(userMeta.fileName);
  });
});
