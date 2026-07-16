// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "../context/types";

const mocks = vi.hoisted(() => ({
  useGenerationController: vi.fn(),
  useLayoutExperience: vi.fn()
}));

vi.mock("../hooks/useGenerationController", () => ({
  useGenerationController: mocks.useGenerationController
}));

vi.mock("../hooks/useLayoutExperience", () => ({
  useLayoutExperience: mocks.useLayoutExperience
}));

import MainPanel from "./MainPanel";

const settings: AppSettings = {
  sdEndpoint: "http://127.0.0.1:7860",
  imageProvider: "forge",
  geminiEndpoint: "",
  geminiApiKey: "",
  geminiModel: "",
  geminiAuthMode: "queryKey",
  offlineMode: false,
  brandColor: "#3c83f6",
  timeoutMultiplier: 1,
  timeoutMinSeconds: 30,
  timeoutMaxSeconds: 300
};

const noop = () => undefined;
const asyncNoop = async () => undefined;

describe("MainPanel layout", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.useGenerationController.mockReturnValue({
      form: {
        positivePrompt: "",
        negativePrompt: "",
        extraPrompt: "",
        steps: 20,
        cfgScale: 7,
        sampler: "",
        scheduler: "",
        model: "",
        vae: "",
        lora: "",
        loraWeight: 1,
        controlNetModel: "",
        controlNetModule: "",
        controlNetWeight: 1,
        denoisingStrength: 0.35,
        maskFeather: 20,
        imageCount: 1,
        resolution: 768,
        seed: -1,
        clipSkip: 0,
        restoreFaces: false,
        tiling: false,
        presetShortcut: ""
      },
      setFormValue: noop,
      resetForm: noop,
      setResolution: noop,
      setPresetShortcut: noop,
      status: "idle",
      progress: 0,
      progressMode: "determinate",
      progressPreview: null,
      progressText: null,
      error: null,
      lastImages: [],
      options: {
        models: [],
        vaes: [],
        loras: [],
        samplers: [],
        schedulers: [],
        controlNetModels: [],
        controlNetModules: []
      },
      optionsLoading: false,
      optionsError: null,
      refreshOptions: asyncNoop,
      runGeneration: asyncNoop,
      stopGeneration: noop,
      generationTasks: [],
      taskConcurrency: 2,
      cancelTask: noop,
      retryTask: asyncNoop,
      cleanupTask: asyncNoop,
      returnTask: asyncNoop,
      removeTask: noop,
      extendTask: noop,
      setTaskAutoReturn: noop,
      history: [],
      historyLoading: false,
      historyError: null,
      restoreHistoryConfig: asyncNoop,
      pasteHistoryResult: asyncNoop,
      batchItems: [],
      addToBatch: asyncNoop,
      removeFromBatch: asyncNoop,
      clearBatch: asyncNoop,
      runBatch: asyncNoop,
      toast: null,
      dismissToast: noop,
      presets: [],
      selectedPreset: null,
      loadPresets: asyncNoop,
      applyPreset: asyncNoop,
      savePreset: asyncNoop,
      deletePreset: asyncNoop,
      setSelectedPreset: noop,
      pushToast: noop,
      translationInput: "",
      setTranslationInput: noop,
      translationResult: "",
      translationError: null,
      translationLoading: false,
      sourceLanguage: "zh",
      targetLanguage: "en",
      setSourceLanguage: noop,
      setTargetLanguage: noop,
      runTranslation: asyncNoop,
      clearTranslation: noop,
      appendTranslationToPositive: noop,
      appendTranslationToNegative: noop,
      appendExtraPromptToPositive: noop,
      appendExtraPromptToNegative: noop
    });
    mocks.useLayoutExperience.mockReturnValue({
      store: {
        version: 1,
        layout: {
          version: 1,
          order: ["prompts", "presets", "translation", "controlnet", "generation", "models", "batch", "outputs"],
          collapsed: []
        },
        snapshots: [],
        undoLayout: null,
        guide: { version: 1, completed: true, stepIndex: 0 }
      },
      loading: false,
      saving: false,
      error: null,
      setSectionCollapsed: asyncNoop,
      moveSection: asyncNoop,
      saveSnapshot: asyncNoop,
      applySnapshot: asyncNoop,
      deleteSnapshot: asyncNoop,
      undoLayout: asyncNoop,
      resetLayout: asyncNoop,
      setGuideStep: asyncNoop,
      completeGuide: asyncNoop,
      restartGuide: asyncNoop
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <MainPanel
          settings={settings}
          settingsLoading={false}
          onUpdateSettings={asyncNoop}
          onOpenSettings={noop}
        />
      );
      await Promise.resolve();
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.getElementById("pxd-overlay-root")?.remove();
    vi.clearAllMocks();
  });

  it("renders visible sections and their focusable toggles in stored order", () => {
    const sections = Array.from(container.querySelectorAll<HTMLElement>("[data-layout-section]"));
    expect(sections.map((section) => section.dataset.layoutSection)).toEqual([
      "prompts",
      "presets",
      "translation",
      "controlnet",
      "generation",
      "models"
    ]);
    expect(sections.map((section) => section.querySelector(".workspace-section__toggle")?.getAttribute("aria-controls")))
      .toEqual([
        "workspace-section-prompts",
        "workspace-section-presets",
        "workspace-section-translation",
        "workspace-section-controlnet",
        "workspace-section-generation",
        "workspace-section-models"
      ]);
  });
});
