import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "../context/types";
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
    getSelectionPixels: vi.fn(),
    groupLayers: vi.fn(),
    hasActiveSelection: vi.fn(),
    moveActiveLayerToTop: vi.fn(),
    onBatchAddLayer: vi.fn(),
    placeImageIntoDocument: vi.fn(),
    placeImageIntoSelection: vi.fn(),
    setSelectionBounds: vi.fn(),
    switchToDocument: vi.fn()
  },
  storage: {
    readJsonFile: vi.fn(),
    writeJsonFile: vi.fn()
  }
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
  deletePresetFile: vi.fn(),
  listPresetMetas: vi.fn().mockResolvedValue([]),
  loadPresetFile: vi.fn(),
  savePresetFile: vi.fn()
}));

vi.mock("../services/translator", () => ({ translateText: vi.fn() }));
vi.mock("../services/uxpBridge", () => ({ bridge: boundary.storage }));

import {
  GenerationRequestSession,
  useGenerationController,
  type BatchItem,
  type GenerationControllerState
} from "./useGenerationController";

const geminiSettings: AppSettings = {
  ...DEFAULT_SETTINGS,
  imageProvider: "gemini",
  offlineMode: false,
  geminiApiKey: "key"
};

const emptyOptions = {
  models: [],
  vaes: [],
  loras: [],
  samplers: [],
  schedulers: [],
  controlNetModels: [],
  controlNetModules: []
};

const selection = (value: string, width = 640, height = 480) => ({
  dataUrl: `data:image/png;base64,${btoa(value)}`,
  width,
  height,
  selectionBounds: { left: 0, top: 0, right: width, bottom: height }
});

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

const renderController = (initialSettings: AppSettings = geminiSettings) => {
  let current: GenerationControllerState | null = null;
  const Harness = ({ settings }: { settings: AppSettings }) => {
    current = useGenerationController(settings);
    return null;
  };
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(createElement(Harness, { settings: initialSettings }));
  });
  return {
    renderer,
    update: (settings: AppSettings) => act(() => {
      renderer.update(createElement(Harness, { settings }));
    }),
    get: () => current as unknown as GenerationControllerState
  };
};

const renderers: TestRenderer.ReactTestRenderer[] = [];
const trackedRender = (settings?: AppSettings) => {
  const rendered = renderController(settings);
  renderers.push(rendered.renderer);
  return rendered;
};

beforeEach(() => {
  vi.clearAllMocks();
  boundary.forgeClient.fetchOptions.mockResolvedValue(emptyOptions);
  boundary.forgeClient.fetchProgress.mockResolvedValue(null);
  boundary.forgeClient.img2img.mockResolvedValue({ images: ["FORGE_RESULT"] });
  boundary.geminiClient.editImage.mockResolvedValue("GEMINI_RESULT");
  boundary.photoshop.closeDocument.mockResolvedValue(undefined);
  boundary.photoshop.getSelectionPixels.mockResolvedValue(selection("DEFAULT"));
  boundary.photoshop.groupLayers.mockResolvedValue(null);
  boundary.photoshop.hasActiveSelection.mockResolvedValue(true);
  boundary.photoshop.moveActiveLayerToTop.mockResolvedValue(undefined);
  boundary.photoshop.onBatchAddLayer.mockResolvedValue(null);
  boundary.photoshop.placeImageIntoSelection.mockResolvedValue({ layerID: 10 });
  boundary.photoshop.setSelectionBounds.mockResolvedValue(undefined);
  boundary.photoshop.switchToDocument.mockResolvedValue(undefined);
  boundary.storage.readJsonFile.mockResolvedValue({ version: 1, entries: [] });
  boundary.storage.writeJsonFile.mockResolvedValue(undefined);
  vi.stubGlobal("Image", class {
    naturalWidth = 1;
    naturalHeight = 1;
    onload: null | (() => void) = null;
    onerror: null | (() => void) = null;
    set src(_value: string) { queueMicrotask(() => this.onload?.()); }
  });
  vi.stubGlobal("document", {
    createElement: vi.fn().mockReturnValue({
      width: 0,
      height: 0,
      getContext: vi.fn().mockReturnValue({ clearRect: vi.fn(), drawImage: vi.fn() }),
      toDataURL: vi.fn().mockReturnValue("data:image/jpeg;base64,THUMB")
    })
  });
});

afterEach(() => {
  for (const renderer of renderers.splice(0)) act(() => renderer.unmount());
  vi.unstubAllGlobals();
});

describe("useGenerationController reference integration", () => {
  it("passes ordered references through the Gemini engine", async () => {
    const rendered = trackedRender();
    await flush();
    boundary.photoshop.getSelectionPixels
      .mockResolvedValueOnce(selection("WIDE", 800, 400))
      .mockResolvedValueOnce(selection("TALL", 200, 800))
      .mockResolvedValueOnce(selection("MAIN", 800, 400));
    await act(async () => rendered.get().captureReferenceImage());
    await act(async () => rendered.get().captureReferenceImage());
    const tallId = rendered.get().referenceImages[1].id;
    act(() => rendered.get().moveReferenceImage(tallId, "left"));
    act(() => rendered.get().setFormValue("positivePrompt", "use references"));

    await act(async () => rendered.get().runGeneration());

    expect(boundary.geminiClient.editImage).toHaveBeenCalledWith(expect.objectContaining({
      baseImageBase64: btoa("MAIN"),
      refImagesBase64: [btoa("TALL"), btoa("WIDE")]
    }));
    expect(rendered.get().referenceAspectWarning).toContain("参考图 1");
  });

  it("invalidates a pending selection at the Forge commit barrier before Gemini starts", async () => {
    const rendered = trackedRender();
    await flush();
    boundary.photoshop.getSelectionPixels.mockResolvedValueOnce(selection("PRIVATE_REF"));
    await act(async () => rendered.get().captureReferenceImage());
    let resolveSelection!: (pixels: ReturnType<typeof selection>) => void;
    boundary.photoshop.getSelectionPixels.mockImplementationOnce(() => new Promise((resolve) => {
      resolveSelection = resolve;
    }));
    let generation!: Promise<void>;
    act(() => { generation = rendered.get().runGeneration(); });

    rendered.update(DEFAULT_SETTINGS);
    await act(async () => {
      resolveSelection(selection("LATE_MAIN"));
      await generation;
    });

    expect(boundary.geminiClient.editImage).not.toHaveBeenCalled();
    expect(boundary.forgeClient.img2img).not.toHaveBeenCalled();
    expect(boundary.photoshop.placeImageIntoSelection).not.toHaveBeenCalled();
  });

  it("aborts a pending Gemini edit and ignores its late result after switching provider", async () => {
    const rendered = trackedRender();
    await flush();
    boundary.photoshop.getSelectionPixels
      .mockResolvedValueOnce(selection("PRIVATE_REF"))
      .mockResolvedValueOnce(selection("MAIN"));
    await act(async () => rendered.get().captureReferenceImage());
    let signal: AbortSignal | undefined;
    let resolveImage!: (image: string) => void;
    boundary.geminiClient.editImage.mockImplementationOnce((params) => new Promise((resolve) => {
      signal = params.signal;
      resolveImage = resolve;
    }));
    let generation!: Promise<void>;
    act(() => { generation = rendered.get().runGeneration(); });
    await flush();

    rendered.update(DEFAULT_SETTINGS);
    await act(async () => {
      resolveImage("LATE_RESULT");
      await generation;
    });

    expect(signal?.aborted).toBe(true);
    expect(boundary.photoshop.placeImageIntoSelection).not.toHaveBeenCalled();
    expect(rendered.get().referenceImages).toEqual([]);
  });

  it("cancels an in-flight Gemini batch request and clears sensitive references when the provider switches", async () => {
    const rendered = trackedRender();
    await flush();
    boundary.photoshop.getSelectionPixels
      .mockResolvedValueOnce(selection("PRIVATE_REF"))
      .mockResolvedValueOnce(selection("BATCH_MAIN"));
    boundary.photoshop.onBatchAddLayer.mockResolvedValueOnce([11, 12, 13]);
    await act(async () => rendered.get().captureReferenceImage());
    await act(async () => rendered.get().addToBatch());
    let signal: AbortSignal | undefined;
    let resolveImage!: (image: string) => void;
    boundary.geminiClient.editImage.mockImplementationOnce((params) => new Promise((resolve) => {
      signal = params.signal;
      resolveImage = resolve;
    }));
    let batch!: Promise<void>;
    act(() => { batch = rendered.get().runBatch(); });
    await flush();

    rendered.update(DEFAULT_SETTINGS);
    await act(async () => {
      resolveImage("LATE_RESULT");
      await batch;
    });

    expect(signal?.aborted).toBe(true);
    expect(boundary.photoshop.placeImageIntoSelection).not.toHaveBeenCalled();
    expect(rendered.get().batchItems[0].referenceImages).toEqual([]);
  });

  it("cleans up a pending batch add invalidated by a provider switch", async () => {
    const rendered = trackedRender();
    await flush();
    boundary.photoshop.getSelectionPixels
      .mockResolvedValueOnce(selection("PRIVATE_REF"))
      .mockResolvedValueOnce(selection("BATCH_MAIN"));
    await act(async () => rendered.get().captureReferenceImage());
    let resolveBatchLayer!: (info: [number, number, number]) => void;
    boundary.photoshop.onBatchAddLayer.mockImplementationOnce(() => new Promise((resolve) => {
      resolveBatchLayer = resolve;
    }));
    let add!: Promise<void>;
    act(() => { add = rendered.get().addToBatch(); });
    await flush();

    rendered.update(DEFAULT_SETTINGS);
    await act(async () => {
      resolveBatchLayer([21, 22, 23]);
      await add;
    });

    expect(boundary.photoshop.closeDocument).toHaveBeenCalledWith(22, 21, 23, expect.any(Object));
    expect(rendered.get().batchItems).toEqual([]);
    rendered.update(geminiSettings);
    expect(rendered.get().batchItems).toEqual([]);
    expect(rendered.get().referenceImages).toEqual([]);
  });

  it("clears retained sensitive holders when a request session is invalidated", () => {
    const references = [{
      id: "reference",
      dataUrl: `data:image/png;base64,${btoa("PRIVATE_REF")}`,
      width: 640,
      height: 480,
      capturedAt: new Date().toISOString()
    }];
    const queued = [{ referenceImages: references }] as BatchItem[];
    const session = new GenerationRequestSession(1, "gemini");
    session.retainReferenceImages(references);
    session.retainBatchItems(queued);

    session.invalidate();

    expect(session.referenceImages).toBeNull();
    expect(session.batchItems).toBeNull();
    expect(session.controller.signal.aborted).toBe(true);
  });
});
