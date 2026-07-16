import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../services/settings";
import { useGenerationController, type GenerationControllerState } from "./useGenerationController";

const serviceMocks = vi.hoisted(() => ({
  fetchOptions: vi.fn(),
  img2img: vi.fn(),
  editImage: vi.fn(),
  getSelectionPixels: vi.fn(),
  placeImageIntoSelection: vi.fn(),
  savePresetFile: vi.fn(),
  loadPresetFile: vi.fn(),
  listPresetMetas: vi.fn()
}));

vi.mock("../services/apiClient", () => ({
  createPxdClient: () => ({
    fetchOptions: serviceMocks.fetchOptions,
    img2img: serviceMocks.img2img,
    fetchProgress: vi.fn(async () => null)
  })
}));

vi.mock("../services/imageModelClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/imageModelClient")>();
  return {
    ...actual,
    createImageModelClient: () => ({ editImage: serviceMocks.editImage })
  };
});

vi.mock("../services/photoshop", () => ({
  closeDocument: vi.fn(),
  deleteLayers: vi.fn(),
  deleteTaskLayers: vi.fn(),
  getActiveDocumentId: vi.fn().mockResolvedValue(7),
  getSelectionPixels: serviceMocks.getSelectionPixels,
  groupLayers: vi.fn(),
  moveActiveLayerToTop: vi.fn(),
  renameLayer: vi.fn(),
  onBatchAddLayer: vi.fn(),
  placeImageIntoSelection: serviceMocks.placeImageIntoSelection,
  setSelectionBounds: vi.fn(async () => undefined),
  switchToDocument: vi.fn()
}));

vi.mock("../services/presets", () => ({
  deletePresetFile: vi.fn(),
  listPresetMetas: serviceMocks.listPresetMetas,
  loadPresetFile: serviceMocks.loadPresetFile,
  savePresetFile: serviceMocks.savePresetFile
}));

vi.mock("../services/translator", () => ({ translateText: vi.fn() }));

const emptyOptions = {
  models: [],
  vaes: [],
  loras: [],
  samplers: [],
  schedulers: [],
  controlNetModels: [],
  controlNetModules: []
};

const renderController = async (imageProvider: "forge" | "gemini") => {
  let controller: GenerationControllerState;
  const settings = {
    ...DEFAULT_SETTINGS,
    imageProvider,
    offlineMode: false
  };
  const Harness = () => {
    controller = useGenerationController(settings);
    return null;
  };
  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(<Harness />);
    await Promise.resolve();
  });
  return {
    get controller() {
      return controller!;
    },
    renderer: renderer!
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  serviceMocks.fetchOptions.mockResolvedValue(emptyOptions);
  serviceMocks.img2img.mockResolvedValue({ images: ["FORGE_IMAGE"] });
  serviceMocks.editImage.mockResolvedValue("GEMINI_IMAGE");
  serviceMocks.getSelectionPixels.mockResolvedValue({
    dataUrl: "data:image/png;base64,BASE",
    width: 64,
    height: 64,
    documentId: 7,
    selectionBounds: { left: 0, top: 0, right: 64, bottom: 64 }
  });
  serviceMocks.placeImageIntoSelection.mockResolvedValue({ layerID: 1 });
  serviceMocks.listPresetMetas.mockResolvedValue([]);
  serviceMocks.savePresetFile.mockResolvedValue({
    meta: {
      name: "parameter-preset",
      fileName: "parameter-preset.json",
      createdAt: "",
      kind: "forge",
      isFactory: false
    },
    preset: { kind: "forge", title: "parameter-preset", data: {} },
    version: 2
  });
  vi.stubGlobal("window", {
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis)
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useGenerationController prompt parameters", () => {
  it("sanitizes Forge prompts and persists the inline values in presets", async () => {
    const harness = await renderController("forge");
    await act(async () => {
      harness.controller.setFormValue(
        "positivePrompt",
        "base, @param:关闭:0.00, keep @param:保留:0.60"
      );
      harness.controller.setFormValue("negativePrompt", "bad, 【关闭:0】, retain");
      harness.controller.setFormValue("extraPrompt", "extra");
    });

    await act(async () => harness.controller.runGeneration());
    expect(serviceMocks.img2img).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "base, keep @param:保留:0.60\nextra",
      negativePrompt: "bad, retain"
    }), expect.anything());

    await act(async () => harness.controller.savePreset("parameter-preset"));
    expect(serviceMocks.savePresetFile).toHaveBeenCalledWith(
      "parameter-preset",
      expect.objectContaining({
        kind: "forge",
        data: expect.objectContaining({
          positivePrompt: "base, @param:关闭:0.00, keep @param:保留:0.60"
        })
      })
    );
    act(() => harness.renderer.unmount());
  });

  it("sanitizes the prompt passed to Gemini", async () => {
    const harness = await renderController("gemini");
    await act(async () => {
      harness.controller.setFormValue("positivePrompt", "portrait 【雾:0.00】 @param:光:0.45");
      harness.controller.setFormValue("extraPrompt", "@param:颗粒:0");
    });

    await act(async () => harness.controller.runGeneration());
    expect(serviceMocks.editImage).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "portrait @param:光:0.45"
    }));
    act(() => harness.renderer.unmount());
  });

  it.each(["forge", "gemini"] as const)(
    "normalizes and sanitizes %s batch prompts",
    async (provider) => {
      const harness = await renderController(provider);
      await act(async () => {
        harness.controller.setFormValue(
          "positivePrompt",
          "scene;  @param:强:2; detail, @param:关:-3, tail"
        );
        harness.controller.setFormValue("extraPrompt", "extra @param:微:.456");
      });
      expect(harness.controller.form.positivePrompt).toBe(
        "scene;  @param:强:1.00; detail, @param:关:0.00, tail"
      );

      await act(async () => {
        await harness.controller.addToBatch();
      });
      expect(harness.controller.batchItems).toHaveLength(1);
      await act(async () => {
        await harness.controller.runBatch();
      });

      const expectedPrompt = "scene;  @param:强:1.00; detail, tail\nextra @param:微:0.46";
      if (provider === "forge") {
        expect(serviceMocks.img2img).toHaveBeenCalledWith(expect.objectContaining({
          prompt: expectedPrompt
        }), expect.anything());
      } else {
        expect(serviceMocks.editImage).toHaveBeenCalledWith(expect.objectContaining({
          prompt: expectedPrompt
        }));
      }
      act(() => harness.renderer.unmount());
    }
  );

  it("normalizes prompt markers restored from a preset", async () => {
    const harness = await renderController("forge");
    serviceMocks.loadPresetFile.mockResolvedValueOnce({
      meta: {
        name: "raw-params",
        fileName: "raw-params.json",
        createdAt: "",
        kind: "forge",
        isFactory: false
      },
      preset: {
        kind: "forge",
        title: "raw-params",
        data: {
          ...harness.controller.form,
          positivePrompt: "@param:过强:4",
          negativePrompt: "【过低：-2】",
          extraPrompt: "@param:正常:.4"
        }
      },
      version: 2
    });

    await act(async () => harness.controller.applyPreset("raw-params.json"));
    expect(harness.controller.form).toEqual(expect.objectContaining({
      positivePrompt: "@param:过强:1.00",
      negativePrompt: "【过低：0.00】",
      extraPrompt: "@param:正常:0.40"
    }));
    act(() => harness.renderer.unmount());
  });
});
