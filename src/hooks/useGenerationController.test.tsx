import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "../context/types";
import type { Img2ImgParams, SdOptions, Txt2ImgParams } from "../services/apiClient";
import { DEFAULT_SETTINGS } from "../services/settings";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const emptyOptions: SdOptions = {
  models: [],
  vaes: [],
  loras: [],
  samplers: [],
  schedulers: [],
  controlNetModels: [],
  controlNetModules: []
};

const boundary = vi.hoisted(() => ({
  client: {
    fetchOptions: vi.fn(),
    fetchProgress: vi.fn(),
    img2img: vi.fn(),
    txt2img: vi.fn()
  },
  getSelectionPixels: vi.fn(),
  createGeneratedDocument: vi.fn(),
  placeImageIntoDocument: vi.fn(),
  placeImageIntoSelection: vi.fn(),
  groupLayers: vi.fn(),
  moveActiveLayerToTop: vi.fn(),
  listPresetMetas: vi.fn()
}));

vi.mock("../services/apiClient", () => ({
  createPxdClient: () => boundary.client
}));

vi.mock("../services/photoshop", () => ({
  closeDocument: vi.fn(),
  createGeneratedDocument: boundary.createGeneratedDocument,
  getSelectionPixels: boundary.getSelectionPixels,
  groupLayers: boundary.groupLayers,
  moveActiveLayerToTop: boundary.moveActiveLayerToTop,
  onBatchAddLayer: vi.fn().mockResolvedValue(null),
  placeImageIntoDocument: boundary.placeImageIntoDocument,
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

import {
  useGenerationController,
  type GenerationControllerState
} from "./useGenerationController";

const selection = {
  dataUrl: "data:image/png;base64,SELECTION",
  width: 640,
  height: 480,
  selectionBounds: { left: 10, top: 20, right: 650, bottom: 500 }
};

const flushEffects = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const mountController = () => {
  let controller: GenerationControllerState | null = null;
  const Harness = ({ settings }: { settings: AppSettings }) => {
    controller = useGenerationController(settings);
    return null;
  };
  let renderer: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(createElement(Harness, { settings: DEFAULT_SETTINGS }));
  });
  return {
    get controller() {
      return controller as unknown as GenerationControllerState;
    },
    renderer: renderer!
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  boundary.client.fetchOptions.mockResolvedValue(emptyOptions);
  boundary.client.fetchProgress.mockResolvedValue(null);
  boundary.client.img2img.mockResolvedValue({ images: ["IMG2IMG"] });
  boundary.client.txt2img.mockResolvedValue({ images: ["TXT_ONE", "TXT_TWO"] });
  boundary.createGeneratedDocument.mockResolvedValue(42);
  boundary.placeImageIntoDocument
    .mockResolvedValueOnce({ layerID: 101 })
    .mockResolvedValueOnce({ layerID: 102 });
  boundary.placeImageIntoSelection.mockResolvedValue({ layerID: 201 });
  boundary.groupLayers.mockResolvedValue(undefined);
  boundary.moveActiveLayerToTop.mockResolvedValue(undefined);
  boundary.listPresetMetas.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useGenerationController Forge completion", () => {
  it("uses txt2img without a selection and places results into a new document", async () => {
    boundary.getSelectionPixels.mockResolvedValue(null);
    const harness = mountController();
    await flushEffects();
    act(() => {
      harness.controller.setFormValue("positivePrompt", "new landscape");
      harness.controller.setFormValue("resolution", 1024);
      harness.controller.setFormValue("lora", "detail-xl");
      harness.controller.setFormValue("loraWeight", 0.7);
    });

    await act(async () => {
      await harness.controller.runGeneration();
    });

    expect(boundary.client.img2img).not.toHaveBeenCalled();
    expect(boundary.client.txt2img).toHaveBeenCalledOnce();
    const params = boundary.client.txt2img.mock.calls[0][0] as Txt2ImgParams;
    expect(params).toMatchObject({
      prompt: "new landscape",
      width: 1024,
      height: 1024,
      loras: [{ name: "detail-xl", weight: 0.7 }]
    });
    expect(params.controlNet).toBeUndefined();
    expect(boundary.createGeneratedDocument).toHaveBeenCalledWith(1024, 1024);
    expect(boundary.placeImageIntoDocument).toHaveBeenNthCalledWith(
      1,
      "data:image/png;base64,TXT_ONE",
      1,
      42
    );
    expect(boundary.placeImageIntoDocument).toHaveBeenNthCalledWith(
      2,
      "data:image/png;base64,TXT_TWO",
      2,
      42
    );
    expect(boundary.groupLayers).toHaveBeenCalledWith([101, 102]);
    expect(harness.controller.status).toBe("success");
    expect(harness.controller.lastImages).toEqual([
      "data:image/png;base64,TXT_ONE",
      "data:image/png;base64,TXT_TWO"
    ]);
    act(() => harness.renderer.unmount());
  });

  it("passes selected LoRA and ControlNet controls to img2img", async () => {
    boundary.getSelectionPixels.mockResolvedValue(selection);
    const harness = mountController();
    await flushEffects();
    act(() => {
      harness.controller.setFormValue("lora", "line-art");
      harness.controller.setFormValue("loraWeight", 0);
      harness.controller.setFormValue("controlNetModel", "control-canny");
      harness.controller.setFormValue("controlNetModule", "canny");
      harness.controller.setFormValue("controlNetWeight", 0.75);
    });

    await act(async () => {
      await harness.controller.runGeneration();
    });

    expect(boundary.client.txt2img).not.toHaveBeenCalled();
    const params = boundary.client.img2img.mock.calls[0][0] as Img2ImgParams;
    expect(params.loras).toEqual([{ name: "line-art", weight: 0 }]);
    expect(params.controlNet).toEqual({
      model: "control-canny",
      module: "canny",
      weight: 0.75,
      guidanceStart: 0,
      guidanceEnd: 1,
      pixelPerfect: true,
      image: selection.dataUrl
    });
    expect(boundary.placeImageIntoSelection).toHaveBeenCalledOnce();
    expect(boundary.createGeneratedDocument).not.toHaveBeenCalled();
    act(() => harness.renderer.unmount());
  });

  it("publishes current_image while Forge generation is running", async () => {
    vi.useFakeTimers();
    boundary.getSelectionPixels.mockResolvedValue(selection);
    boundary.client.fetchProgress.mockResolvedValue({
      progress: 0.5,
      eta_relative: 2,
      current_image: "LIVE_PREVIEW",
      textinfo: "Sampling"
    });
    let resolveGeneration: ((value: { images: string[] }) => void) | null = null;
    boundary.client.img2img.mockImplementation(() => new Promise((resolve) => {
      resolveGeneration = resolve;
    }));
    const harness = mountController();
    await flushEffects();
    let generationPromise: Promise<void>;
    act(() => {
      generationPromise = harness.controller.runGeneration();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(harness.controller.progress).toBe(0.5);
    expect(harness.controller.progressPreview).toBe(
      "data:image/png;base64,LIVE_PREVIEW"
    );
    expect(harness.controller.progressText).toBe("Sampling");

    await act(async () => {
      resolveGeneration?.({ images: ["DONE"] });
      await generationPromise!;
    });
    expect(harness.controller.progressPreview).toBeNull();
    act(() => harness.renderer.unmount());
  });
});
