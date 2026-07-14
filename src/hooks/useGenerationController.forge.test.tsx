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
  closeGeneratedDocument: vi.fn(),
  createGeneratedDocument: vi.fn(),
  placeImageIntoDocument: vi.fn(),
  placeImageIntoSelection: vi.fn(),
  groupLayers: vi.fn(),
  moveActiveLayerToTop: vi.fn(),
  listPresetMetas: vi.fn()
}));

vi.mock("../services/apiClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/apiClient")>()),
  createPxdClient: () => boundary.client
}));

vi.mock("../services/photoshop", () => ({
  closeDocument: vi.fn(),
  closeGeneratedDocument: boundary.closeGeneratedDocument,
  createGeneratedDocument: boundary.createGeneratedDocument,
  getSelectionPixels: boundary.getSelectionPixels,
  groupLayers: boundary.groupLayers,
  moveActiveLayerToTop: boundary.moveActiveLayerToTop,
  onBatchAddLayer: vi.fn().mockResolvedValue(null),
  placeImageIntoDocument: boundary.placeImageIntoDocument,
  placeImageIntoSelection: boundary.placeImageIntoSelection,
  setSelectionBounds: vi.fn().mockResolvedValue(undefined),
  switchToDocument: vi.fn().mockResolvedValue(undefined)
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
  Object.values(boundary.client).forEach((mock) => mock.mockReset());
  boundary.getSelectionPixels.mockReset();
  boundary.closeGeneratedDocument.mockReset();
  boundary.createGeneratedDocument.mockReset();
  boundary.placeImageIntoDocument.mockReset();
  boundary.placeImageIntoSelection.mockReset();
  boundary.groupLayers.mockReset();
  boundary.moveActiveLayerToTop.mockReset();
  boundary.listPresetMetas.mockReset();
  boundary.client.fetchOptions.mockResolvedValue(emptyOptions);
  boundary.client.fetchProgress.mockResolvedValue(null);
  boundary.client.img2img.mockResolvedValue({ images: ["IMG2IMG"] });
  boundary.client.txt2img.mockResolvedValue({ images: ["TXT_ONE", "TXT_TWO"] });
  boundary.closeGeneratedDocument.mockResolvedValue(undefined);
  boundary.createGeneratedDocument.mockResolvedValue({
    documentId: 42,
    previousDocumentId: 7
  });
  boundary.placeImageIntoDocument
    .mockResolvedValueOnce({ layerID: 101 })
    .mockResolvedValueOnce({ layerID: 102 });
  boundary.placeImageIntoSelection.mockResolvedValue({ layerID: 201 });
  boundary.groupLayers.mockResolvedValue(301);
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
    expect(boundary.createGeneratedDocument).toHaveBeenCalledWith(1024, 1024, undefined, expect.anything());
    expect(boundary.placeImageIntoDocument).toHaveBeenNthCalledWith(
      1,
      "data:image/png;base64,TXT_ONE",
      1,
      42, expect.anything()
    );
    expect(boundary.placeImageIntoDocument).toHaveBeenNthCalledWith(
      2,
      "data:image/png;base64,TXT_TWO",
      2,
      42, expect.anything()
    );
    expect(boundary.groupLayers).toHaveBeenCalledWith(
      [101, 102],
      undefined,
      { taskId: expect.any(String) }
    );
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

  it("drops an in-flight progress response after stop and during the next generation", async () => {
    vi.useFakeTimers();
    boundary.getSelectionPixels.mockResolvedValue(selection);
    let resolveProgress: ((value: {
      progress: number;
      eta_relative: number;
      current_image: string;
      textinfo: string;
    }) => void) | null = null;
    boundary.client.fetchProgress.mockImplementation(() => new Promise((resolve) => {
      resolveProgress = resolve;
    }));
    let resolveFirst: ((value: { images: string[] }) => void) | null = null;
    let resolveSecond: ((value: { images: string[] }) => void) | null = null;
    boundary.client.img2img
      .mockReset()
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveFirst = resolve;
      }))
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveSecond = resolve;
      }));
    const harness = mountController();
    await flushEffects();
    let firstPromise: Promise<void>;
    act(() => {
      firstPromise = harness.controller.runGeneration();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(boundary.client.fetchProgress).toHaveBeenCalledOnce();

    await act(async () => {
      resolveFirst?.({ images: ["FIRST"] });
      await firstPromise!;
    });
    let secondPromise: Promise<void>;
    act(() => {
      secondPromise = harness.controller.runGeneration();
    });
    await act(async () => {
      resolveProgress?.({
        progress: 0.9,
        eta_relative: 1,
        current_image: "STALE_PREVIEW",
        textinfo: "Stale"
      });
      await Promise.resolve();
    });

    expect(harness.controller.progress).toBe(0);
    expect(harness.controller.progressPreview).toBeNull();
    expect(harness.controller.progressText).toBeNull();
    await act(async () => {
      resolveSecond?.({ images: ["SECOND"] });
      await secondPromise!;
    });
    act(() => harness.renderer.unmount());
  });

  it("clears the live preview in the batch finally path", async () => {
    vi.useFakeTimers();
    boundary.getSelectionPixels.mockResolvedValue(selection);
    boundary.client.fetchProgress.mockResolvedValue({
      progress: 0.25,
      eta_relative: 4,
      current_image: "BATCH_PREVIEW",
      textinfo: "Batch sampling"
    });
    let resolveGeneration: ((value: { images: string[] }) => void) | null = null;
    boundary.client.img2img.mockImplementation(() => new Promise((resolve) => {
      resolveGeneration = resolve;
    }));
    const harness = mountController();
    await flushEffects();
    await act(async () => {
      await harness.controller.addToBatch();
    });
    expect(harness.controller.batchItems).toHaveLength(1);
    let batchPromise: Promise<void>;
    act(() => {
      batchPromise = harness.controller.runBatch();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(boundary.client.img2img).toHaveBeenCalledOnce();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(harness.controller.progressPreview).toBe(
      "data:image/png;base64,BATCH_PREVIEW"
    );

    await act(async () => {
      resolveGeneration?.({ images: ["DONE"] });
      await batchPromise!;
    });
    expect(harness.controller.progress).toBe(0);
    expect(harness.controller.progressPreview).toBeNull();
    expect(harness.controller.progressText).toBeNull();
    act(() => harness.renderer.unmount());
  });

  it("cleans up a failed txt2img document without replacing the placement error", async () => {
    boundary.getSelectionPixels.mockResolvedValue(null);
    boundary.client.txt2img.mockResolvedValue({ images: ["OUTPUT"] });
    boundary.placeImageIntoDocument
      .mockReset()
      .mockRejectedValueOnce(new Error("place failed"));
    boundary.closeGeneratedDocument.mockRejectedValueOnce(new Error("cleanup failed"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const harness = mountController();
    await flushEffects();

    await act(async () => {
      await harness.controller.runGeneration();
    });

    expect(boundary.closeGeneratedDocument).toHaveBeenCalledWith(42, 7, expect.anything());
    expect(harness.controller.status).toBe("error");
    expect(harness.controller.error).toBe("place failed");
    expect(warning).toHaveBeenCalledWith(
      "Failed to clean up generated document",
      expect.objectContaining({ message: "cleanup failed" })
    );
    warning.mockRestore();
    act(() => harness.renderer.unmount());
  });

  it("keeps the txt2img document when grouping fails (best-effort grouping)", async () => {
    boundary.getSelectionPixels.mockResolvedValue(null);
    boundary.groupLayers.mockRejectedValueOnce(new Error("group failed"));
    const harness = mountController();
    await flushEffects();

    await act(async () => {
      await harness.controller.runGeneration();
    });

    expect(boundary.closeGeneratedDocument).not.toHaveBeenCalled();
    expect(harness.controller.status).toBe("success");
    act(() => harness.renderer.unmount());
  });
});
