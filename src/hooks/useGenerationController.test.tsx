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
    getSelectionPixels: vi.fn(),
    groupLayers: vi.fn(),
    hasActiveSelection: vi.fn(),
    moveActiveLayerToTop: vi.fn(),
    onBatchAddLayer: vi.fn(),
    placeImageIntoSelection: vi.fn(),
    captureRelightSource: vi.fn(),
    validateRelightSource: vi.fn(),
    placeRelitResult: vi.fn(),
    rollbackRelitResult: vi.fn(),
    restoreRelightContext: vi.fn(),
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

vi.mock("../services/uxpBridge", () => ({
  bridge: boundary.storage
}));

import {
  mapForgeDataToForm,
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
  boundary.photoshop.hasActiveSelection.mockResolvedValue(true);
  boundary.photoshop.placeImageIntoSelection.mockResolvedValue({ layerID: 101 });
  boundary.photoshop.captureRelightSource.mockResolvedValue({
    dataUrl: "data:image/png;base64,RELIGHT_SOURCE",
    documentId: 7,
    documentWidth: 640,
    documentHeight: 480,
    selectionBounds: null
  });
  boundary.photoshop.validateRelightSource.mockResolvedValue(undefined);
  boundary.photoshop.placeRelitResult.mockResolvedValue({ layerId: 303 });
  boundary.photoshop.rollbackRelitResult.mockResolvedValue(undefined);
  boundary.photoshop.restoreRelightContext.mockResolvedValue(undefined);
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

describe("useGenerationController relight integration", () => {
  const geminiSettings: AppSettings = {
    ...DEFAULT_SETTINGS,
    imageProvider: "gemini",
    offlineMode: false
  };

  it("runs Gemini relighting, places non-destructively, and records the light plan", async () => {
    const rendered = trackedRender({ initialSettings: geminiSettings });
    await flush();
    act(() => rendered.getController().setFormValue("positivePrompt", "gentle portrait light"));

    await act(async () => rendered.getController().runRelight());

    expect(rendered.getController().status).toBe("success");
    expect(rendered.getController().relightStatus).toBe("success");
    expect(boundary.geminiClient.editImage).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining("Additional direction: gentle portrait light"),
      baseImageBase64: "RELIGHT_SOURCE",
      taskId: expect.any(String)
    }));
    expect(boundary.photoshop.placeRelitResult).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: 7 }),
      "data:image/png;base64,GEMINI_RESULT",
      expect.any(Function),
      { taskId: expect.any(String) }
    );
    expect(rendered.getController().history[0].params.relightConfig?.lights.map((light) => light.role))
      .toEqual(["key", "rim"]);
  });

  it("blocks Forge relighting before Photoshop capture", async () => {
    const rendered = trackedRender();
    await flush();
    await act(async () => rendered.getController().runRelight());
    expect(rendered.getController().status).toBe("error");
    expect(rendered.getController().relightStatus).toBe("error");
    expect(boundary.photoshop.captureRelightSource).not.toHaveBeenCalled();
  });

  it("stops an in-flight relight before Photoshop placement", async () => {
    let settle!: (value: string) => void;
    boundary.geminiClient.editImage.mockReturnValueOnce(new Promise<string>((resolve) => { settle = resolve; }));
    const rendered = trackedRender({ initialSettings: geminiSettings });
    await flush();
    let run!: Promise<void>;
    act(() => { run = rendered.getController().runRelight(); });
    await vi.waitFor(() => expect(boundary.geminiClient.editImage).toHaveBeenCalled());
    act(() => rendered.getController().stopGeneration());
    await act(async () => {
      settle("LATE_RESULT");
      await run;
    });
    expect(boundary.photoshop.placeRelitResult).not.toHaveBeenCalled();
    expect(rendered.getController().status).toBe("idle");
    expect(rendered.getController().relightStatus).toBe("idle");
  });
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
