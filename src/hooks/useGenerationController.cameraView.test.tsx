import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GenerationEngine } from "../services/generationEngine";
import { DEFAULT_SETTINGS } from "../services/settings";

const boundary = vi.hoisted(() => ({
  cameraEngine: null as unknown as GenerationEngine,
  forgeEngine: null as unknown as GenerationEngine,
  loadCameraView: vi.fn(),
  saveCameraView: vi.fn(),
  getSelectionPixels: vi.fn(),
  placeImageIntoSelection: vi.fn(),
  groupLayers: vi.fn(),
  moveActiveLayerToTop: vi.fn(),
  listPresetMetas: vi.fn(),
  recordHistory: vi.fn()
}));

vi.mock("../services/generationEngine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/generationEngine")>()),
  createGenerationEngine: () => boundary.cameraEngine
}));

vi.mock("./useGenerationEngine", () => ({
  useGenerationEngine: () => boundary.forgeEngine
}));

vi.mock("../services/cameraView", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/cameraView")>()),
  loadCameraView: boundary.loadCameraView,
  saveCameraView: boundary.saveCameraView
}));

vi.mock("./useGenerationHistory", () => ({
  useGenerationHistory: () => ({
    entries: [],
    loading: false,
    error: null,
    record: boundary.recordHistory
  })
}));

vi.mock("../services/photoshop", () => ({
  closeDocument: vi.fn(),
  closeGeneratedDocument: vi.fn(),
  createGeneratedDocument: vi.fn(),
  getSelectionPixels: boundary.getSelectionPixels,
  groupLayers: boundary.groupLayers,
  hasActiveSelection: vi.fn(),
  moveActiveLayerToTop: boundary.moveActiveLayerToTop,
  onBatchAddLayer: vi.fn(),
  placeImageIntoDocument: vi.fn(),
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

vi.mock("../services/translator", () => ({ translateText: vi.fn() }));

import { useGenerationController, type GenerationControllerState } from "./useGenerationController";

const emptyOptions = {
  models: [],
  vaes: [],
  loras: [],
  samplers: [],
  schedulers: [],
  controlNetModels: [],
  controlNetModules: []
};

const settings = {
  ...DEFAULT_SETTINGS,
  imageProvider: "forge" as const,
  offlineMode: false,
  geminiApiKey: "configured-key"
};

const renderController = () => {
  let controller: GenerationControllerState | null = null;
  const Harness = () => {
    controller = useGenerationController(settings);
    return null;
  };
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(createElement(Harness));
  });
  return {
    renderer,
    get: () => controller as unknown as GenerationControllerState
  };
};

const renderers: TestRenderer.ReactTestRenderer[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  boundary.cameraEngine = {
    provider: "gemini",
    progressMode: "indeterminate",
    generate: vi.fn().mockResolvedValue({ images: ["CAMERA_RESULT"] }),
    cancel: vi.fn().mockReturnValue(false),
    cancelAll: vi.fn().mockReturnValue(0)
  };
  boundary.forgeEngine = {
    provider: "forge",
    progressMode: "determinate",
    generate: vi.fn(),
    cancel: vi.fn().mockReturnValue(false),
    cancelAll: vi.fn().mockReturnValue(0),
    fetchOptions: vi.fn().mockResolvedValue(emptyOptions),
    fetchProgress: vi.fn().mockResolvedValue(null)
  };
  boundary.loadCameraView.mockResolvedValue({ azimuth: 45, elevation: -15, distance: 1.4 });
  boundary.saveCameraView.mockResolvedValue(undefined);
  boundary.getSelectionPixels.mockResolvedValue({
    dataUrl: "data:image/png;base64,BASE_SELECTION",
    width: 640,
    height: 480,
    selectionBounds: { left: 0, top: 0, right: 640, bottom: 480 }
  });
  boundary.placeImageIntoSelection.mockResolvedValue({ layerID: 91 });
  boundary.groupLayers.mockResolvedValue(null);
  boundary.moveActiveLayerToTop.mockResolvedValue(undefined);
  boundary.listPresetMetas.mockResolvedValue([]);
  boundary.recordHistory.mockResolvedValue({ id: "history-camera" });
});

afterEach(() => {
  for (const renderer of renderers.splice(0)) act(() => renderer.unmount());
});

describe("useGenerationController camera view", () => {
  it("restores and persists a normalized camera state", async () => {
    const rendered = renderController();
    renderers.push(rendered.renderer);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(rendered.get().cameraViewLoading).toBe(false);
    expect(rendered.get().cameraView).toEqual({ azimuth: 45, elevation: -15, distance: 1.4 });

    act(() => rendered.get().setCameraView({ azimuth: 67, elevation: 17, distance: 2.31 }));
    expect(rendered.get().cameraView).toEqual({ azimuth: 45, elevation: 15, distance: 2.4 });
    expect(boundary.saveCameraView).toHaveBeenCalledWith({ azimuth: 45, elevation: 15, distance: 2.4 });
  });

  it("sends the selection and mapped camera prompt through Gemini, then pastes and records it", async () => {
    const rendered = renderController();
    renderers.push(rendered.renderer);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => rendered.get().runCameraViewGeneration());

    expect(boundary.forgeEngine.generate).not.toHaveBeenCalled();
    expect(boundary.cameraEngine.generate).toHaveBeenCalledWith(expect.objectContaining({
      baseImageBase64: "BASE_SELECTION",
      prompt: expect.stringContaining("right front three-quarter view"),
      taskId: expect.any(String)
    }));
    expect(boundary.placeImageIntoSelection).toHaveBeenCalledWith(
      "data:image/png;base64,CAMERA_RESULT",
      1,
      expect.objectContaining({ feather: 20, taskId: expect.any(String) })
    );
    expect(boundary.moveActiveLayerToTop).toHaveBeenCalledWith(expect.objectContaining({
      layerId: 91,
      taskId: expect.any(String)
    }));
    expect(boundary.recordHistory).toHaveBeenCalledWith(expect.objectContaining({
      provider: "gemini",
      prompt: expect.stringContaining("Preserve the subject's identity"),
      resultDataUrl: "data:image/png;base64,CAMERA_RESULT"
    }));
    expect(rendered.get().lastImages).toEqual(["data:image/png;base64,CAMERA_RESULT"]);
    expect(rendered.get().status).toBe("success");
    expect(rendered.get().error).toBeNull();
  });

  it("does not call Gemini without a selection", async () => {
    const rendered = renderController();
    renderers.push(rendered.renderer);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    boundary.getSelectionPixels.mockResolvedValueOnce(null);
    await act(async () => {
      await rendered.get().runCameraViewGeneration();
    });
    expect(boundary.cameraEngine.generate).not.toHaveBeenCalled();
    expect(boundary.placeImageIntoSelection).not.toHaveBeenCalled();
    expect(rendered.get().status).toBe("error");
    expect(rendered.get().error).toContain("选择一个主体区域");
  });

  it("stops the dedicated Gemini request even while Forge is the selected provider", async () => {
    let resolveGeneration!: (result: { images: string[] }) => void;
    boundary.cameraEngine.generate = vi.fn().mockImplementation(() => new Promise((resolve) => {
      resolveGeneration = resolve;
    }));
    const rendered = renderController();
    renderers.push(rendered.renderer);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    let generation!: Promise<void>;
    act(() => {
      generation = rendered.get().runCameraViewGeneration();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(rendered.get().status).toBe("running");
    expect(rendered.get().progressMode).toBe("indeterminate");

    act(() => rendered.get().stopGeneration());
    expect(boundary.cameraEngine.cancelAll).toHaveBeenCalledOnce();
    expect(boundary.forgeEngine.cancelAll).not.toHaveBeenCalled();
    await act(async () => {
      resolveGeneration({ images: ["LATE"] });
      await generation;
    });
    expect(boundary.placeImageIntoSelection).not.toHaveBeenCalled();
    expect(rendered.get().status).toBe("idle");
  });
});
