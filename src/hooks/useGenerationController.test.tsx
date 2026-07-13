import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "../context/types";
import type { SdOptions } from "../services/apiClient";
import type { GenerationEngine } from "../services/generationEngine";
import { DEFAULT_SETTINGS } from "../services/settings";

const boundary = vi.hoisted(() => ({
  engine: null as unknown as GenerationEngine,
  getSelectionPixels: vi.fn(),
  placeImageIntoSelection: vi.fn(),
  groupLayers: vi.fn(),
  moveActiveLayerToTop: vi.fn(),
  listPresetMetas: vi.fn()
}));

vi.mock("./useGenerationEngine", () => ({
  useGenerationEngine: () => boundary.engine
}));

vi.mock("../services/photoshop", () => ({
  closeDocument: vi.fn(),
  getSelectionPixels: boundary.getSelectionPixels,
  groupLayers: boundary.groupLayers,
  moveActiveLayerToTop: boundary.moveActiveLayerToTop,
  onBatchAddLayer: vi.fn().mockResolvedValue(null),
  placeImageIntoSelection: boundary.placeImageIntoSelection,
  setSelectionBounds: vi.fn(),
  switchToDocument: vi.fn()
}));

vi.mock("../services/presets", () => ({
  deletePresetFile: vi.fn(),
  listPresetMetas: boundary.listPresetMetas,
  loadPresetFile: vi.fn(),
  savePresetFile: vi.fn()
}));

vi.mock("../services/translator", () => ({
  translateText: vi.fn()
}));

import {
  useGenerationController,
  type GenerationControllerState
} from "./useGenerationController";

const emptyOptions: SdOptions = {
  models: [],
  vaes: [],
  loras: [],
  samplers: [],
  schedulers: [],
  controlNetModels: [],
  controlNetModules: []
};

const modelOptions = (value: string): SdOptions => ({
  ...emptyOptions,
  models: [{ label: value, value, raw: null }]
});

const makeEngine = (
  provider: GenerationEngine["provider"],
  overrides: Partial<GenerationEngine> = {}
): GenerationEngine => ({
  provider,
  progressMode: provider === "forge" ? "determinate" : "indeterminate",
  generate: vi.fn().mockResolvedValue({ images: [`${provider}-image`] }),
  ...(provider === "forge"
    ? {
        fetchOptions: vi.fn().mockResolvedValue(emptyOptions),
        fetchProgress: vi.fn().mockResolvedValue(null)
      }
    : {}),
  ...overrides
});

const flushEffects = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  boundary.listPresetMetas.mockResolvedValue([]);
  boundary.placeImageIntoSelection.mockResolvedValue({ layerID: 1 });
  boundary.groupLayers.mockResolvedValue(undefined);
  boundary.moveActiveLayerToTop.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useGenerationController engine switching", () => {
  it("keeps the newest Forge options during a rapid Forge-Gemini-Forge switch", async () => {
    let resolveOldOptions: ((options: SdOptions) => void) | null = null;
    const oldOptions = vi.fn().mockImplementation(() => new Promise<SdOptions>((resolve) => {
      resolveOldOptions = resolve;
    }));
    const forgeOne = makeEngine("forge", { fetchOptions: oldOptions });
    const gemini = makeEngine("gemini");
    const forgeTwo = makeEngine("forge", {
      fetchOptions: vi.fn().mockResolvedValue(modelOptions("new-model"))
    });
    let controller: GenerationControllerState | null = null;
    const Harness = ({ settings }: { settings: AppSettings }) => {
      controller = useGenerationController(settings);
      return null;
    };

    boundary.engine = forgeOne;
    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(createElement(Harness, { settings: DEFAULT_SETTINGS }));
    });
    await flushEffects();
    expect(oldOptions).toHaveBeenCalledOnce();

    const geminiSettings: AppSettings = {
      ...DEFAULT_SETTINGS,
      imageProvider: "gemini",
      offlineMode: false,
      geminiApiKey: "key"
    };
    boundary.engine = gemini;
    act(() => renderer.update(createElement(Harness, { settings: geminiSettings })));
    boundary.engine = forgeTwo;
    act(() => renderer.update(createElement(Harness, {
      settings: { ...DEFAULT_SETTINGS, sdEndpoint: "http://new-forge.test:7860" }
    })));
    await flushEffects();

    await act(async () => {
      resolveOldOptions?.(modelOptions("stale-model"));
      await Promise.resolve();
    });

    const current = controller as unknown as GenerationControllerState;
    expect(current.options.models.map(({ value }) => value)).toEqual(["new-model"]);
    expect(current.optionsLoading).toBe(false);
    act(() => renderer.unmount());
  });

  it("drops late Forge progress, stops polling, and does not place its stale result", async () => {
    vi.useFakeTimers();
    let resolveProgress: ((value: { progress: number; eta_relative: number }) => void) | null = null;
    let resolveGeneration: ((value: { images: string[] }) => void) | null = null;
    const fetchProgress = vi.fn().mockImplementation(() => new Promise((resolve) => {
      resolveProgress = resolve;
    }));
    const forge = makeEngine("forge", {
      fetchProgress,
      generate: vi.fn().mockImplementation(() => new Promise((resolve) => {
        resolveGeneration = resolve;
      }))
    });
    const gemini = makeEngine("gemini");
    boundary.getSelectionPixels.mockResolvedValue({
      dataUrl: "data:image/png;base64,INPUT",
      width: 512,
      height: 512,
      selectionBounds: { left: 0, top: 0, right: 512, bottom: 512 }
    });
    let controller: GenerationControllerState | null = null;
    const Harness = ({ settings }: { settings: AppSettings }) => {
      controller = useGenerationController(settings);
      return null;
    };

    boundary.engine = forge;
    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(createElement(Harness, { settings: DEFAULT_SETTINGS }));
    });
    await flushEffects();
    let generationPromise: Promise<void>;
    act(() => {
      generationPromise = (controller as unknown as GenerationControllerState).runGeneration();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(fetchProgress).toHaveBeenCalledOnce();

    boundary.engine = gemini;
    act(() => renderer.update(createElement(Harness, {
      settings: {
        ...DEFAULT_SETTINGS,
        imageProvider: "gemini",
        offlineMode: false,
        geminiApiKey: "key"
      }
    })));
    await act(async () => {
      resolveProgress?.({ progress: 0.9, eta_relative: 1 });
      resolveGeneration?.({ images: ["stale-image"] });
      await generationPromise!;
      await vi.advanceTimersByTimeAsync(3_000);
    });

    const current = controller as unknown as GenerationControllerState;
    expect(current.progress).toBe(0);
    expect(fetchProgress).toHaveBeenCalledOnce();
    expect(boundary.placeImageIntoSelection).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });
});
