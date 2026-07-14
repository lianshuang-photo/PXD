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
    txt2img: vi.fn(),
    cancel: vi.fn(),
    cancelAll: vi.fn()
  },
  getSelectionPixels: vi.fn(),
  closeGeneratedDocument: vi.fn(),
  createGeneratedDocument: vi.fn(),
  deleteLayers: vi.fn(),
  getActiveDocumentId: vi.fn(),
  placeImageIntoDocument: vi.fn(),
  placeImageIntoSelection: vi.fn(),
  groupLayers: vi.fn(),
  moveActiveLayerToTop: vi.fn(),
  listPresetMetas: vi.fn(),
  onBatchAddLayer: vi.fn(),
  setSelectionBounds: vi.fn(),
  switchToDocument: vi.fn()
}));

vi.mock("../services/apiClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/apiClient")>()),
  createPxdClient: () => boundary.client
}));

vi.mock("../services/photoshop", () => ({
  closeDocument: vi.fn(),
  closeGeneratedDocument: boundary.closeGeneratedDocument,
  createGeneratedDocument: boundary.createGeneratedDocument,
  deleteLayers: boundary.deleteLayers,
  getActiveDocumentId: boundary.getActiveDocumentId,
  getSelectionPixels: boundary.getSelectionPixels,
  groupLayers: boundary.groupLayers,
  moveActiveLayerToTop: boundary.moveActiveLayerToTop,
  onBatchAddLayer: boundary.onBatchAddLayer,
  placeImageIntoDocument: boundary.placeImageIntoDocument,
  placeImageIntoSelection: boundary.placeImageIntoSelection,
  setSelectionBounds: boundary.setSelectionBounds,
  switchToDocument: boundary.switchToDocument
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

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((candidateResolve) => {
    resolve = candidateResolve;
  });
  return { promise, resolve };
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
  boundary.deleteLayers.mockReset();
  boundary.getActiveDocumentId.mockReset();
  boundary.placeImageIntoDocument.mockReset();
  boundary.placeImageIntoSelection.mockReset();
  boundary.groupLayers.mockReset();
  boundary.moveActiveLayerToTop.mockReset();
  boundary.listPresetMetas.mockReset();
  boundary.onBatchAddLayer.mockReset();
  boundary.setSelectionBounds.mockReset();
  boundary.switchToDocument.mockReset();
  boundary.client.fetchOptions.mockResolvedValue(emptyOptions);
  boundary.client.fetchProgress.mockResolvedValue(null);
  boundary.client.img2img.mockResolvedValue({ images: ["IMG2IMG"] });
  boundary.client.txt2img.mockResolvedValue({ images: ["TXT_ONE", "TXT_TWO"] });
  boundary.client.cancel.mockReturnValue(true);
  boundary.client.cancelAll.mockReturnValue(0);
  boundary.closeGeneratedDocument.mockResolvedValue(undefined);
  boundary.createGeneratedDocument.mockResolvedValue({
    documentId: 42,
    previousDocumentId: 7
  });
  boundary.deleteLayers.mockResolvedValue(undefined);
  boundary.getActiveDocumentId.mockResolvedValue(7);
  boundary.placeImageIntoDocument
    .mockResolvedValueOnce({ layerID: 101 })
    .mockResolvedValueOnce({ layerID: 102 });
  boundary.placeImageIntoSelection.mockResolvedValue({ layerID: 201 });
  boundary.groupLayers.mockResolvedValue(301);
  boundary.moveActiveLayerToTop.mockResolvedValue(undefined);
  boundary.listPresetMetas.mockResolvedValue([]);
  boundary.onBatchAddLayer.mockResolvedValue(null);
  boundary.setSelectionBounds.mockResolvedValue(undefined);
  boundary.switchToDocument.mockResolvedValue(undefined);
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
      { taskId: expect.any(String), requireGroup: true }
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

  it("publishes task progress and countdown while Forge generation is running", async () => {
    boundary.getSelectionPixels.mockResolvedValue(selection);
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

    await flushEffects();
    expect(harness.controller.generationTasks[0]).toMatchObject({
      status: "running",
      progress: 0.02
    });
    expect(harness.controller.generationTasks[0].countdown).toBeGreaterThan(0);
    expect(harness.controller.progressPreview).toBeNull();

    await act(async () => {
      resolveGeneration?.({ images: ["DONE"] });
      await generationPromise!;
    });
    expect(harness.controller.progressPreview).toBeNull();
    act(() => harness.renderer.unmount());
  });

  it("drops a cancelled task's late result without affecting the next task", async () => {
    boundary.getSelectionPixels.mockResolvedValue(selection);
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
    await flushEffects();
    const firstId = harness.controller.generationTasks[0].id;
    await act(async () => {
      await harness.controller.cancelTask(firstId);
      await firstPromise!;
    });
    let secondPromise: Promise<void>;
    act(() => {
      secondPromise = harness.controller.runGeneration();
    });
    await flushEffects();
    await act(async () => {
      resolveFirst?.({ images: ["STALE"] });
      resolveSecond?.({ images: ["SECOND"] });
      await secondPromise!;
    });
    expect(boundary.client.cancel).toHaveBeenCalledWith(firstId);
    expect(boundary.placeImageIntoSelection).toHaveBeenCalledOnce();
    expect(boundary.placeImageIntoSelection).toHaveBeenCalledWith(
      "data:image/png;base64,SECOND",
      1,
      expect.anything()
    );
    act(() => harness.renderer.unmount());
  });

  it("starts batch network requests concurrently", async () => {
    boundary.getSelectionPixels.mockResolvedValue(selection);
    let resolveFirst: ((value: { images: string[] }) => void) | null = null;
    let resolveSecond: ((value: { images: string[] }) => void) | null = null;
    boundary.client.img2img
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));
    const harness = mountController();
    await flushEffects();
    await act(async () => {
      await harness.controller.addToBatch();
      await harness.controller.addToBatch();
    });
    expect(harness.controller.batchItems).toHaveLength(2);
    let batchPromise: Promise<void>;
    act(() => {
      batchPromise = harness.controller.runBatch();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(boundary.client.img2img).toHaveBeenCalledTimes(2);
    expect(harness.controller.batchItems.map(({ status }) => status)).toEqual(["running", "running"]);

    await act(async () => {
      resolveFirst?.({ images: ["FIRST"] });
      resolveSecond?.({ images: ["SECOND"] });
      await batchPromise!;
    });
    expect(harness.controller.batchItems.map(({ status }) => status)).toEqual(["success", "success"]);
    act(() => harness.renderer.unmount());
  });

  it("does not interleave document switches across delayed return workflows", async () => {
    const firstPlacement = deferred<{ layerID: number }>();
    boundary.getSelectionPixels.mockResolvedValue(selection);
    boundary.onBatchAddLayer
      .mockResolvedValueOnce([11, 101, 201])
      .mockResolvedValueOnce([22, 202, 302]);
    boundary.client.img2img
      .mockResolvedValueOnce({ images: ["FIRST"] })
      .mockResolvedValueOnce({ images: ["SECOND"] });
    boundary.placeImageIntoSelection
      .mockImplementationOnce(() => firstPlacement.promise)
      .mockResolvedValueOnce({ layerID: 402 });
    const harness = mountController();
    await flushEffects();
    await act(async () => {
      await harness.controller.addToBatch();
      await harness.controller.addToBatch();
    });

    let batchPromise!: Promise<void>;
    act(() => {
      batchPromise = harness.controller.runBatch();
    });
    await flushEffects();
    expect(boundary.client.img2img).toHaveBeenCalledTimes(2);
    expect(boundary.switchToDocument.mock.calls.map(([documentId]) => documentId)).toEqual([11]);

    await act(async () => {
      firstPlacement.resolve({ layerID: 401 });
      await batchPromise;
    });
    expect(boundary.switchToDocument.mock.calls.map(([documentId]) => documentId)).toEqual([11, 22]);
    expect(harness.controller.batchItems.map(({ status }) => status)).toEqual(["success", "success"]);
    act(() => harness.renderer.unmount());
  });

  it("cleans up a failed txt2img document without replacing the placement error", async () => {
    boundary.getSelectionPixels.mockResolvedValue(null);
    boundary.client.txt2img.mockResolvedValue({ images: ["OUTPUT"] });
    boundary.placeImageIntoDocument
      .mockReset()
      .mockRejectedValueOnce(new Error("place failed"));
    boundary.closeGeneratedDocument.mockRejectedValueOnce(new Error("cleanup failed"));
    const harness = mountController();
    await flushEffects();

    await act(async () => {
      await harness.controller.runGeneration();
    });

    expect(boundary.closeGeneratedDocument).toHaveBeenCalledTimes(2);
    expect(boundary.closeGeneratedDocument).toHaveBeenCalledWith(42, 7, expect.anything());
    expect(harness.controller.status).toBe("error");
    expect(harness.controller.error).toBe("place failed");
    act(() => harness.renderer.unmount());
  });

  it("rolls back the txt2img document when grouping fails", async () => {
    boundary.getSelectionPixels.mockResolvedValue(null);
    boundary.groupLayers.mockRejectedValueOnce(new Error("group failed"));
    const harness = mountController();
    await flushEffects();

    await act(async () => {
      await harness.controller.runGeneration();
    });

    expect(boundary.closeGeneratedDocument).toHaveBeenCalledWith(42, 7, expect.anything());
    expect(harness.controller.status).toBe("error");
    act(() => harness.renderer.unmount());
  });

  it("deletes the generated group and restores the document before manual return retry", async () => {
    boundary.getSelectionPixels.mockResolvedValue(selection);
    boundary.client.img2img.mockResolvedValue({ images: ["ONE", "TWO"] });
    boundary.placeImageIntoSelection
      .mockResolvedValueOnce({ layerID: 201 })
      .mockResolvedValueOnce({ layerID: 202 })
      .mockResolvedValueOnce({ layerID: 203 })
      .mockResolvedValueOnce({ layerID: 204 });
    boundary.groupLayers
      .mockResolvedValueOnce(301)
      .mockResolvedValueOnce(302);
    boundary.moveActiveLayerToTop
      .mockRejectedValueOnce(new Error("move failed"))
      .mockResolvedValueOnce(undefined);
    const harness = mountController();
    await flushEffects();

    await act(async () => {
      await harness.controller.runGeneration();
    });
    const taskId = harness.controller.generationTasks[0].id;
    expect(harness.controller.generationTasks[0].status).toBe("error");
    expect(boundary.deleteLayers).toHaveBeenCalledWith([301], { taskId });
    expect(boundary.switchToDocument).toHaveBeenCalledWith(7, { taskId });

    await act(async () => {
      await harness.controller.retryTask(taskId);
    });
    expect(harness.controller.generationTasks[0].status).toBe("success");
    expect(boundary.placeImageIntoSelection).toHaveBeenCalledTimes(4);
    act(() => harness.renderer.unmount());
  });
});
