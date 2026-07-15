import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PxdRequestCancelledError } from "../services/apiClient";
import { DEFAULT_SETTINGS } from "../services/settings";
import MainPanel from "./MainPanel";

const serviceMocks = vi.hoisted(() => ({
  fetchOptions: vi.fn(),
  img2img: vi.fn(),
  fetchProgress: vi.fn(),
  forgeCancelAll: vi.fn(),
  imageCancelAll: vi.fn(),
  geminiEdit: vi.fn(),
  generationRejectors: [] as Array<(error: Error) => void>,
  optionRejectors: [] as Array<(error: Error) => void>,
  getSelectionPixels: vi.fn(),
  prepareColorizeSource: vi.fn(),
  placeColorizedResult: vi.fn(),
  restoreColorizeContext: vi.fn(),
  deleteLayer: vi.fn()
}));

vi.mock("../services/apiClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/apiClient")>();
  return {
    ...actual,
    createPxdClient: () => ({
      ping: vi.fn(),
      fetchOptions: serviceMocks.fetchOptions,
      txt2img: vi.fn(),
      img2img: serviceMocks.img2img,
      fetchProgress: serviceMocks.fetchProgress,
      cancel: vi.fn(() => false),
      cancelAll: serviceMocks.forgeCancelAll
    })
  };
});

vi.mock("../services/imageModelClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/imageModelClient")>();
  return {
    ...actual,
    createImageModelClient: () => ({
      editImage: serviceMocks.geminiEdit,
      cancel: vi.fn(() => false),
      cancelAll: serviceMocks.imageCancelAll
    })
  };
});

vi.mock("../services/photoshop", () => ({
  deleteLayer: serviceMocks.deleteLayer,
  getSelectionPixels: serviceMocks.getSelectionPixels,
  closeDocument: vi.fn(),
  groupLayers: vi.fn(),
  moveActiveLayerToTop: vi.fn(),
  onBatchAddLayer: vi.fn(),
  placeColorizedResult: serviceMocks.placeColorizedResult,
  placeImageIntoSelection: vi.fn(),
  prepareColorizeSource: serviceMocks.prepareColorizeSource,
  restoreColorizeContext: serviceMocks.restoreColorizeContext,
  setSelectionBounds: vi.fn(),
  switchToDocument: vi.fn()
}));

vi.mock("../services/presets", () => ({
  deletePresetFile: vi.fn(),
  listPresetMetas: vi.fn(async () => []),
  loadPresetFile: vi.fn(),
  savePresetFile: vi.fn()
}));

vi.mock("../services/translator", () => ({
  translateText: vi.fn()
}));

const emptyOptions = {
  models: [],
  vaes: [],
  loras: [],
  samplers: [],
  schedulers: [],
  controlNetModels: [],
  controlNetModules: []
};

const buttonByText = (renderer: ReactTestRenderer, text: string) => {
  const button = renderer.root.findAllByType("button").find((candidate) => candidate.children.join("") === text);
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
};

beforeEach(() => {
  vi.clearAllMocks();
  serviceMocks.generationRejectors.length = 0;
  serviceMocks.optionRejectors.length = 0;
  serviceMocks.fetchOptions.mockResolvedValue(emptyOptions);
  serviceMocks.fetchProgress.mockResolvedValue(null);
  serviceMocks.getSelectionPixels.mockResolvedValue({
    dataUrl: "data:image/png;base64,BASE",
    width: 64,
    height: 64,
    selectionBounds: { left: 0, top: 0, right: 64, bottom: 64 }
  });
  serviceMocks.prepareColorizeSource.mockResolvedValue({
    dataUrl: "data:image/png;base64,GRAY",
    documentId: 7,
    documentWidth: 100,
    documentHeight: 80,
    selectionBounds: { left: 0, top: 0, right: 64, bottom: 64 },
    squareSize: 64
  });
  serviceMocks.geminiEdit.mockResolvedValue("COLOR");
  serviceMocks.placeColorizedResult.mockResolvedValue({ layerId: 41 });
  serviceMocks.restoreColorizeContext.mockResolvedValue(undefined);
  serviceMocks.deleteLayer.mockResolvedValue(undefined);
  serviceMocks.img2img.mockImplementation(() => new Promise((_resolve, reject) => {
    serviceMocks.generationRejectors.push(reject);
  }));
  serviceMocks.forgeCancelAll.mockImplementation(() => {
    const generationRejectors = serviceMocks.generationRejectors.splice(0);
    const optionRejectors = serviceMocks.optionRejectors.splice(0);
    for (const reject of generationRejectors) reject(new Error("aborted"));
    for (const reject of optionRejectors) reject(new PxdRequestCancelledError());
    return generationRejectors.length + optionRejectors.length;
  });
  serviceMocks.imageCancelAll.mockReturnValue(0);
  vi.stubGlobal("window", {
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis)
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MainPanel generation controls", () => {
  it("enables intelligent colorization only for the closed-source engine", async () => {
    let forgeRenderer: ReactTestRenderer;
    await act(async () => {
      forgeRenderer = create(<MainPanel settings={{ ...DEFAULT_SETTINGS, offlineMode: false }} onOpenSettings={vi.fn()} />);
      await Promise.resolve();
    });
    expect(buttonByText(forgeRenderer!, "智能调色").props.disabled).toBe(true);
    await act(async () => forgeRenderer!.unmount());

    let geminiRenderer: ReactTestRenderer;
    await act(async () => {
      geminiRenderer = create(
        <MainPanel
          settings={{ ...DEFAULT_SETTINGS, imageProvider: "gemini", offlineMode: false }}
          onOpenSettings={vi.fn()}
        />
      );
      await Promise.resolve();
    });
    expect(buttonByText(geminiRenderer!, "智能调色").props.disabled).toBe(false);
    const prompt = geminiRenderer!.root.findByProps({ placeholder: "调色方向，例如：自然暖色、保留肤色" });
    await act(async () => {
      prompt.props.onChange({ target: { value: "warm skin tones" } });
    });
    await act(async () => {
      await buttonByText(geminiRenderer!, "智能调色").props.onClick();
    });
    expect(serviceMocks.geminiEdit).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining("warm skin tones")
    }));
    expect(JSON.stringify(geminiRenderer!.toJSON())).toContain("已完成");
    await act(async () => geminiRenderer!.unmount());
  });

  it("disables refresh while running and the controller rejects direct refresh calls", async () => {
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<MainPanel settings={{ ...DEFAULT_SETTINGS, offlineMode: false }} onOpenSettings={vi.fn()} />);
      await Promise.resolve();
    });
    expect(serviceMocks.fetchOptions).toHaveBeenCalledTimes(1);

    let generationPromise: Promise<void>;
    await act(async () => {
      generationPromise = buttonByText(renderer!, "开始生成").props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(serviceMocks.img2img).toHaveBeenCalledOnce();

    const refresh = buttonByText(renderer!, "刷新");
    expect(refresh.props.disabled).toBe(true);
    expect(buttonByText(renderer!, "停止").props.disabled).toBe(false);
    await act(async () => {
      await refresh.props.onClick();
    });
    expect(serviceMocks.fetchOptions).toHaveBeenCalledTimes(1);

    await act(async () => {
      renderer!.unmount();
      await generationPromise!;
    });
  });

  it("preserves existing options when stop cancels an in-flight refresh", async () => {
    serviceMocks.fetchOptions.mockResolvedValueOnce({
      ...emptyOptions,
      models: [{ label: "Existing model", value: "existing-model", raw: {} }]
    });
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<MainPanel settings={{ ...DEFAULT_SETTINGS, offlineMode: false }} onOpenSettings={vi.fn()} />);
      await Promise.resolve();
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain("Existing model");

    serviceMocks.fetchOptions.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      serviceMocks.optionRejectors.push(reject);
    }));
    let refreshPromise: Promise<void>;
    await act(async () => {
      refreshPromise = buttonByText(renderer!, "刷新").props.onClick();
      await Promise.resolve();
    });

    let generationPromise: Promise<void>;
    await act(async () => {
      generationPromise = buttonByText(renderer!, "开始生成").props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      buttonByText(renderer!, "停止").props.onClick();
      await Promise.all([refreshPromise!, generationPromise!]);
    });

    const rendered = JSON.stringify(renderer!.toJSON());
    expect(rendered).toContain("Existing model");
    expect(rendered).not.toContain("Request cancelled");
    await act(async () => renderer!.unmount());
  });
});
