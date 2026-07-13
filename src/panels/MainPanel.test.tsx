import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../services/settings";
import type { GenerationControllerState, GenerationForm } from "../hooks/useGenerationController";

const boundary = vi.hoisted(() => ({
  controller: null as unknown as GenerationControllerState
}));

vi.mock("../hooks/useGenerationController", () => ({
  useGenerationController: () => boundary.controller
}));

import MainPanel from "./MainPanel";

const form: GenerationForm = {
  positivePrompt: "current",
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
};

beforeEach(() => {
  const restoreHistoryConfig = vi.fn();
  const pasteHistoryResult = vi.fn().mockResolvedValue(undefined);
  const noop = vi.fn();
  boundary.controller = {
    form,
    setFormValue: noop,
    resetForm: noop,
    setResolution: noop,
    setPresetShortcut: noop,
    status: "idle",
    progress: 0,
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
    refreshOptions: noop,
    runGeneration: noop,
    history: [{
      id: "history-1",
      ts: 1_000,
      provider: "gemini",
      prompt: "remembered prompt",
      params: { ...form, positivePrompt: "remembered prompt", steps: 32 },
      thumbnailDataUrl: "data:image/jpeg;base64,THUMB"
    }],
    historyLoading: false,
    historyError: null,
    restoreHistoryConfig,
    pasteHistoryResult,
    batchItems: [],
    addToBatch: noop,
    removeFromBatch: noop,
    clearBatch: noop,
    runBatch: noop,
    toast: null,
    dismissToast: noop,
    presets: [],
    selectedPreset: null,
    loadPresets: noop,
    applyPreset: noop,
    savePreset: noop,
    deletePreset: noop,
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
    runTranslation: noop,
    clearTranslation: noop,
    appendTranslationToPositive: noop,
    appendTranslationToNegative: noop,
    appendExtraPromptToPositive: noop,
    appendExtraPromptToNegative: noop
  };
});

describe("MainPanel generation history", () => {
  it("renders the thumbnail and wires both one-click history actions", () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(createElement(MainPanel, {
        settings: DEFAULT_SETTINGS,
        onOpenSettings: vi.fn()
      }));
    });

    const image = renderer.root.findByProps({ className: "generation-history__thumbnail" });
    expect(image.props.src).toBe("data:image/jpeg;base64,THUMB");
    const buttons = renderer.root.findAllByType("button");
    const restore = buttons.find((button) => button.children.join("") === "回填配置");
    const paste = buttons.find((button) => button.children.join("") === "再次贴回");

    act(() => restore?.props.onClick());
    act(() => paste?.props.onClick());

    expect(boundary.controller.restoreHistoryConfig).toHaveBeenCalledWith("history-1");
    expect(boundary.controller.pasteHistoryResult).toHaveBeenCalledWith("history-1");
    act(() => renderer.unmount());
  });
});
