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
    captureAtlasRegion: vi.fn(),
    closeDocument: vi.fn(),
    getSelectionPixels: vi.fn(),
    groupLayers: vi.fn(),
    hasActiveSelection: vi.fn(),
    moveActiveLayerToTop: vi.fn(),
    onBatchAddLayer: vi.fn(),
    placeMultiRegionAtlas: vi.fn(),
    placeImageIntoSelection: vi.fn(),
    releaseAtlasRegions: vi.fn(),
    setSelectionBounds: vi.fn(),
    switchToDocument: vi.fn()
  },
  storage: {
    readJsonFile: vi.fn(),
    writeJsonFile: vi.fn()
  },
  atlasWorkflow: vi.fn(),
  thumbnailDecodeFails: false
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

vi.mock("../services/multiRegionAtlasWorkflow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/multiRegionAtlasWorkflow")>()),
  executeMultiRegionAtlasWorkflow: boundary.atlasWorkflow
}));

vi.mock("../services/presets", () => ({
  deletePresetFile: vi.fn(),
  listPresetMetas: vi.fn().mockResolvedValue([]),
  loadPresetFile: vi.fn(),
  savePresetFile: vi.fn()
}));

vi.mock("../services/translator", () => ({
  translateText: vi.fn()
}));

vi.mock("../services/uxpBridge", () => ({
  bridge: boundary.storage
}));

import {
  useGenerationController,
  type GenerationControllerState,
  type GenerationForm
} from "./useGenerationController";

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
  boundary.photoshop.captureAtlasRegion.mockResolvedValue({
    id: "atlas-one",
    documentId: 7,
    bounds: { left: 10, top: 20, right: 650, bottom: 500 },
    sourceWidth: 640,
    sourceHeight: 480,
    imageWidth: 640,
    imageHeight: 480,
    dataUrl: "data:image/png;base64,INPUT",
    encodedBytes: 5,
    selectionChannelName: "channel-one"
  });
  boundary.photoshop.placeMultiRegionAtlas.mockResolvedValue({ layerIds: [101], groupId: 50 });
  boundary.photoshop.releaseAtlasRegions.mockResolvedValue(undefined);
  boundary.atlasWorkflow.mockImplementation(async ({ regions, adapters, taskId, isCurrent }: {
    regions: Array<{ id: string; documentId: number }>;
    adapters: { place: (...args: any[]) => Promise<{ layerIds: number[]; groupId: number }> };
    taskId: string;
    isCurrent: () => boolean;
  }) => {
    const parts = regions.map((region) => ({
      regionId: region.id,
      dataUrl: `data:image/png;base64,${region.id}`,
      width: 640,
      height: 480,
      encodedBytes: 8
    }));
    const placement = await adapters.place(regions[0].documentId, regions, parts, {
      taskId,
      maxWorkingBytes: 96 * 1024 * 1024,
      isCurrent
    });
    return {
      parts,
      ...placement,
      previewDataUrl: "data:image/png;base64,atlas-preview"
    };
  });
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

describe("useGenerationController multi-region atlas", () => {
  const geminiSettings: AppSettings = {
    ...DEFAULT_SETTINGS,
    imageProvider: "gemini",
    offlineMode: false,
    geminiApiKey: "key"
  };

  it("collects unique same-document selections and commits split previews plus history", async () => {
    const rendered = trackedRender({ initialSettings: geminiSettings });
    await flush();
    act(() => rendered.getController().setFormValue("positivePrompt", "same treatment"));

    await act(async () => rendered.getController().addAtlasRegion());
    await act(async () => rendered.getController().addAtlasRegion());
    expect(rendered.getController().atlasRegions).toHaveLength(1);
    expect(rendered.getController().toast).toMatchObject({ type: "warning" });
    expect(boundary.photoshop.releaseAtlasRegions).toHaveBeenCalledWith(
      [expect.objectContaining({ id: "atlas-one", selectionChannelName: "channel-one" })],
      expect.objectContaining({ taskId: expect.any(String) })
    );

    boundary.photoshop.captureAtlasRegion.mockResolvedValueOnce({
      ...rendered.getController().atlasRegions[0],
      id: "atlas-two",
      bounds: { left: 700, top: 20, right: 1000, bottom: 420 },
      sourceWidth: 300,
      sourceHeight: 400,
      imageWidth: 300,
      imageHeight: 400
    });
    await act(async () => rendered.getController().addAtlasRegion());
    await act(async () => rendered.getController().runMultiRegionAtlas());

    expect(boundary.atlasWorkflow).toHaveBeenCalledOnce();
    expect(rendered.getController().status).toBe("success");
    expect(rendered.getController().atlasRunning).toBe(false);
    expect(rendered.getController().lastImages).toEqual([
      "data:image/png;base64,atlas-preview"
    ]);
    expect(rendered.getController().history).toHaveLength(1);
  });

  it("serializes rapid add-region requests so the same selection cannot be captured twice", async () => {
    let resolveCapture!: (value: any) => void;
    boundary.photoshop.captureAtlasRegion.mockImplementationOnce(() => new Promise((resolve) => {
      resolveCapture = resolve;
    }));
    const rendered = trackedRender({ initialSettings: geminiSettings });
    await flush();

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = rendered.getController().addAtlasRegion();
      second = rendered.getController().addAtlasRegion();
    });
    expect(boundary.photoshop.captureAtlasRegion).toHaveBeenCalledOnce();
    resolveCapture({
      id: "atlas-one",
      documentId: 7,
      bounds: { left: 10, top: 20, right: 650, bottom: 500 },
      sourceWidth: 640,
      sourceHeight: 480,
      imageWidth: 640,
      imageHeight: 480,
      dataUrl: "data:image/png;base64,INPUT",
      encodedBytes: 5,
      selectionChannelName: "channel-one"
    });
    await act(async () => {
      await Promise.all([first, second]);
    });
    expect(rendered.getController().atlasRegions).toHaveLength(1);
  });

  it("releases temporary selection channels for rejected, removed, and cleared regions", async () => {
    const rendered = trackedRender({ initialSettings: geminiSettings });
    await flush();
    await act(async () => rendered.getController().addAtlasRegion());

    boundary.photoshop.captureAtlasRegion.mockResolvedValueOnce({
      ...rendered.getController().atlasRegions[0],
      id: "other-document",
      documentId: 99,
      selectionChannelName: "channel-other"
    });
    await act(async () => rendered.getController().addAtlasRegion());
    expect(boundary.photoshop.releaseAtlasRegions).toHaveBeenLastCalledWith(
      [expect.objectContaining({ id: "other-document" })],
      expect.objectContaining({ taskId: expect.any(String) })
    );

    await act(async () => rendered.getController().removeAtlasRegion("atlas-one"));
    expect(boundary.photoshop.releaseAtlasRegions).toHaveBeenLastCalledWith(
      [expect.objectContaining({ id: "atlas-one" })],
      expect.objectContaining({ taskId: expect.any(String) })
    );
    expect(rendered.getController().atlasRegions).toEqual([]);

    await act(async () => rendered.getController().addAtlasRegion());
    await act(async () => rendered.getController().clearAtlasRegions());
    expect(boundary.photoshop.releaseAtlasRegions).toHaveBeenLastCalledWith(
      [expect.objectContaining({ id: "atlas-one" })],
      expect.objectContaining({ taskId: expect.any(String) })
    );
    expect(rendered.getController().atlasRegions).toEqual([]);
  });

  it("treats Photoshop placement as committed when stop races with workflow return", async () => {
    let finishWorkflow!: () => void;
    const afterPlacement = new Promise<void>((resolve) => { finishWorkflow = resolve; });
    boundary.atlasWorkflow.mockImplementationOnce(async ({ regions, adapters, taskId, isCurrent }: any) => {
      const parts = regions.map((region: any) => ({
        regionId: region.id,
        dataUrl: "data:image/png;base64,PLACED",
        width: 640,
        height: 480,
        encodedBytes: 6
      }));
      const placement = await adapters.place(regions[0].documentId, regions, parts, {
        taskId,
        maxWorkingBytes: 96 * 1024 * 1024,
        isCurrent
      });
      await afterPlacement;
      return { ...placement, parts, previewDataUrl: "data:image/png;base64,committed" };
    });
    const rendered = trackedRender({ initialSettings: geminiSettings });
    await flush();
    act(() => rendered.getController().setFormValue("positivePrompt", "same treatment"));
    await act(async () => rendered.getController().addAtlasRegion());

    let run!: Promise<void>;
    act(() => { run = rendered.getController().runMultiRegionAtlas(); });
    await vi.waitFor(() => expect(boundary.photoshop.placeMultiRegionAtlas).toHaveBeenCalledOnce());
    act(() => rendered.getController().stopGeneration());
    finishWorkflow();
    await act(async () => run);

    expect(rendered.getController().status).toBe("success");
    expect(rendered.getController().lastImages).toEqual(["data:image/png;base64,committed"]);
    expect(rendered.getController().atlasRegions).toEqual([]);
  });

  it("keeps the settlement gate closed until cancellation cleanup finishes", async () => {
    let rejectWorkflow!: (error: Error) => void;
    boundary.atlasWorkflow.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      rejectWorkflow = reject;
    }));
    const rendered = trackedRender({ initialSettings: geminiSettings });
    await flush();
    act(() => rendered.getController().setFormValue("positivePrompt", "same treatment"));
    await act(async () => rendered.getController().addAtlasRegion());

    let run!: Promise<void>;
    act(() => {
      run = rendered.getController().runMultiRegionAtlas();
    });
    await vi.waitFor(() => expect(boundary.atlasWorkflow).toHaveBeenCalledOnce());
    act(() => rendered.getController().stopGeneration());
    expect(rendered.getController().atlasStopping).toBe(true);
    expect(rendered.getController().status).toBe("running");

    await act(async () => rendered.getController().runGeneration());
    expect(boundary.photoshop.getSelectionPixels).not.toHaveBeenCalled();

    rejectWorkflow(Object.assign(new Error("cancelled"), { code: "ENGINE_STALE" }));
    await act(async () => run);
    expect(rendered.getController().atlasStopping).toBe(false);
    expect(rendered.getController().status).toBe("idle");
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
