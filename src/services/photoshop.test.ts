import { beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  bridge: {
    photoshop: null as any,
    uxp: undefined as any,
    getDataFolder: vi.fn(),
    createSessionToken: vi.fn()
  }
}));

vi.mock("./uxpBridge", () => ({ bridge: boundary.bridge }));

import {
  captureAtlasRegion,
  closeGeneratedDocument,
  createGeneratedDocument,
  groupLayers,
  placeMultiRegionAtlas,
  releaseAtlasRegions
} from "./photoshop";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createGeneratedDocument", () => {
  it("creates a transparent RGB canvas through the Photoshop DOM", async () => {
    const createDocument = vi.fn().mockResolvedValue({ id: 77 });
    const executeAsModal = vi.fn().mockImplementation(async (callback) => await callback());
    boundary.bridge.photoshop = {
      app: { createDocument, batchPlay: vi.fn(), activeDocument: { id: 1 } },
      core: { executeAsModal }
    };

    const id = await createGeneratedDocument(768, 512, "Generated");

    expect(id).toEqual({ documentId: 77, previousDocumentId: 1 });
    expect(createDocument).toHaveBeenCalledWith({
      width: 768,
      height: 512,
      resolution: 72,
      mode: "RGBColorMode",
      fill: "transparent",
      name: "Generated"
    });
    expect(executeAsModal).toHaveBeenCalledWith(expect.any(Function), {
      commandName: "创建 PXD 文生图画布"
    });
  });

  it("falls back to batchPlay when createDocument is unavailable", async () => {
    const batchPlay = vi.fn().mockResolvedValue([{ documentID: 88 }]);
    boundary.bridge.photoshop = {
      app: { batchPlay, activeDocument: { id: 1 } },
      core: { executeAsModal: vi.fn().mockImplementation(async (callback) => await callback()) }
    };

    const id = await createGeneratedDocument(1024, 1024);

    expect(id).toEqual({ documentId: 88, previousDocumentId: 1 });
    expect(batchPlay).toHaveBeenCalledWith(
      [expect.objectContaining({
        _obj: "make",
        _target: [{ _ref: "document" }],
        using: expect.objectContaining({
          width: { _unit: "pixelsUnit", _value: 1024 },
          height: { _unit: "pixelsUnit", _value: 1024 }
        })
      })],
      { synchronousExecution: true }
    );
  });

  it("closes a failed generated document and restores the previous document", async () => {
    const batchPlay = vi.fn().mockResolvedValue([]);
    boundary.bridge.photoshop = {
      app: { batchPlay, activeDocument: { id: 88 } },
      core: { executeAsModal: vi.fn().mockImplementation(async (callback) => await callback()) }
    };

    await closeGeneratedDocument(88, 7);

    expect(batchPlay).toHaveBeenNthCalledWith(1, [{
      _obj: "close",
      _target: [{ _ref: "document", _id: 88 }],
      saving: { _enum: "yesNo", _value: "no" }
    }], { synchronousExecution: true });
    expect(batchPlay).toHaveBeenNthCalledWith(2, [
      { _obj: "select", _target: [{ _ref: "document", _id: 7 }] }
    ], { synchronousExecution: true });
  });

  it("still attempts to restore the previous document when closing fails", async () => {
    const closeError = new Error("close failed");
    const batchPlay = vi.fn()
      .mockRejectedValueOnce(closeError)
      .mockResolvedValueOnce([]);
    boundary.bridge.photoshop = {
      app: { batchPlay, activeDocument: { id: 88 } },
      core: { executeAsModal: vi.fn().mockImplementation(async (callback) => await callback()) }
    };

    await expect(closeGeneratedDocument(88, 7)).rejects.toBe(closeError);

    expect(batchPlay).toHaveBeenCalledTimes(2);
    expect(batchPlay.mock.calls[1][0]).toEqual([
      { _obj: "select", _target: [{ _ref: "document", _id: 7 }] }
    ]);
  });

  it("rejects strict grouping when Photoshop leaves a regular layer active", async () => {
    boundary.bridge.getDataFolder.mockResolvedValue(undefined);
    const batchPlay = vi.fn().mockResolvedValue([{
      layerID: 201,
      layerSection: { _value: "layerSectionContent" }
    }]);
    boundary.bridge.photoshop = {
      app: { batchPlay, activeDocument: { id: 1 } },
      core: { executeAsModal: vi.fn().mockImplementation(async (callback) => await callback()) }
    };

    await expect(groupLayers([101, 102], "Generated", {
      requireGroup: true
    })).rejects.toThrow("Photoshop 未创建预期的图层组");
  });
});

describe("multi-region atlas Photoshop primitives", () => {
  it("captures the current selection at bounded resolution and records actual encoded bytes", async () => {
    const dispose = vi.fn();
    const getPixels = vi.fn().mockResolvedValue({ imageData: { dispose } });
    const encodeImageData = vi.fn().mockResolvedValue("QUI=");
    boundary.bridge.getDataFolder.mockResolvedValue({
      createFile: vi.fn().mockResolvedValue({ write: vi.fn() })
    });
    boundary.bridge.createSessionToken.mockResolvedValue("capture-jsx");
    const batchPlay = vi.fn().mockResolvedValue([{ javaScriptMessage: "true" }]);
    boundary.bridge.photoshop = {
      app: {
        batchPlay,
        activeDocument: {
          id: 7,
          selection: { bounds: { left: 10, top: 20, right: 1610, bottom: 820 } }
        }
      },
      imaging: { getPixels, encodeImageData },
      core: { executeAsModal: vi.fn().mockImplementation(async (callback) => await callback()) }
    };

    const capture = await captureAtlasRegion(800, { taskId: "atlas" });

    expect(getPixels).toHaveBeenCalledWith(expect.objectContaining({
      documentID: 7,
      sourceBounds: { left: 10, top: 20, right: 1610, bottom: 820 },
      targetSize: { width: 800, height: 400 }
    }));
    expect(capture).toMatchObject({
      documentId: 7,
      sourceWidth: 1600,
      sourceHeight: 800,
      imageWidth: 800,
      imageHeight: 400,
      encodedBytes: 2,
      selectionChannelName: expect.stringContaining("__PXD_ATLAS_7_")
    });
    expect(batchPlay).toHaveBeenCalledWith(
      [expect.objectContaining({ _obj: "AdobeScriptAutomation Scripts" })],
      { modalBehavior: "execute", synchronousExecution: false }
    );
    expect(dispose).toHaveBeenCalledOnce();
  });

  interface PlacementHarnessOptions {
    failTransformVerification?: boolean;
    failGrouping?: boolean;
    failChannelCleanup?: boolean;
    failDelete?: boolean;
    failResume?: boolean;
    pauseMainModal?: Promise<void>;
    onRestoreSelection?: () => void;
  }

  const setupPlacement = (options: PlacementHarnessOptions = {}) => {
    let activeDocumentId = 20;
    let activeLayerId = 9;
    const layerBounds = new Map<number, { left: number; top: number; right: number; bottom: number }>();
    const maskedLayers = new Set<number>();
    const deleted: number[] = [];
    const transforms: any[] = [];
    const featherRadii: number[] = [];
    const scriptTokens: string[] = [];
    const suspendHistory = vi.fn().mockResolvedValue("history-suspension");
    const resumeHistory = options.failResume
      ? vi.fn().mockRejectedValue(new Error("resume failed"))
      : vi.fn().mockResolvedValue(undefined);
    const batchPlay = vi.fn().mockImplementation(async (descriptors: any[]) => {
      const descriptor = descriptors[0];
      if (descriptor?._obj === "select" && descriptor._target?.[0]?._ref === "document") {
        activeDocumentId = descriptor._target[0]._id;
      } else if (descriptor?._obj === "placeEvent") {
        activeLayerId = activeLayerId === 9 ? 101 : 102;
        layerBounds.set(activeLayerId, { left: 0, top: 0, right: 100, bottom: 100 });
      } else if (descriptor?._obj === "transform") {
        transforms.push(descriptor);
        const before = layerBounds.get(activeLayerId)!;
        const width = (before.right - before.left) * descriptor.width._value / 100;
        const height = (before.bottom - before.top) * descriptor.height._value / 100;
        const centerX = (before.left + before.right) / 2 + descriptor.offset.horizontal._value;
        const centerY = (before.top + before.bottom) / 2 + descriptor.offset.vertical._value;
        layerBounds.set(activeLayerId, {
          left: centerX - width / 2,
          top: centerY - height / 2,
          right: centerX + width / 2,
          bottom: centerY + height / 2
        });
      } else if (descriptor?._obj === "AdobeScriptAutomation Scripts") {
        const token = String(descriptor.javaScript?._path ?? "");
        scriptTokens.push(token);
        if (token.includes("atlas-cleanup-channels") && options.failChannelCleanup) {
          return [{ javaScriptMessage: "ERROR:channel cleanup failed" }];
        }
        if (token.includes("atlas-store-selection")) return [{ javaScriptMessage: "STORED" }];
        if (token.includes("atlas-restore-selection")) options.onRestoreSelection?.();
        return [{ javaScriptMessage: "OK" }];
      } else if (descriptor?._obj === "delete") {
        if (options.failDelete) throw new Error("delete failed");
        for (const item of descriptors) deleted.push(item._target[0]._id);
      } else if (descriptor?._obj === "feather") {
        featherRadii.push(descriptor.radius._value);
      } else if (descriptor?._obj === "make" && descriptor.at?._value === "mask") {
        maskedLayers.add(activeLayerId);
      } else if (descriptor?._obj === "make" && descriptor._target?.[0]?._ref === "layerSection") {
        if (options.failGrouping) return [];
        activeLayerId = 50;
      } else if (descriptor?._obj === "select" && descriptor._target?.[0]?._ref === "layer") {
        activeLayerId = descriptor._target[0]._id;
      }
      if (descriptor?._obj === "get") {
        if (activeLayerId === 50) {
          return [{ layerID: 50, layerSection: { _value: "layerSectionStart" } }];
        }
        const requestedId = descriptor._target?.[0]?._id;
        const id = Number(requestedId ?? activeLayerId);
        const bounds = layerBounds.get(id) ?? { left: 0, top: 0, right: 100, bottom: 100 };
        return [{
          layerID: id,
          layerKind: 5,
          smartObject: {},
          hasUserMask: maskedLayers.has(id),
          bounds: options.failTransformVerification && requestedId
            ? { ...bounds, right: bounds.right + 10 }
            : bounds
        }];
      }
      return [];
    });
    const sourceDocument = {
      id: 10,
      get activeLayer() { return { id: activeLayerId }; },
      get activeLayers() { return [{ id: activeLayerId }]; }
    };
    const restoreDocument = {
      id: 20,
      selection: {},
      get activeLayer() { return { id: activeLayerId }; },
      get activeLayers() { return [{ id: activeLayerId }]; }
    };
    const app = {
      batchPlay,
      get activeDocument() { return activeDocumentId === 10 ? sourceDocument : restoreDocument; }
    };
    boundary.bridge.getDataFolder.mockResolvedValue({
      createFile: vi.fn().mockImplementation(async (name: string) => ({ name, write: vi.fn() }))
    });
    boundary.bridge.createSessionToken.mockImplementation(async (file: { name: string }) => file.name);
    boundary.bridge.uxp = {
      storage: {
        formats: { binary: "binary" },
        localFileSystem: {
          getTemporaryFolder: vi.fn().mockResolvedValue({
            createFile: vi.fn().mockResolvedValue({ write: vi.fn() })
          }),
          createSessionToken: vi.fn().mockResolvedValue("image-token")
        }
      }
    };
    boundary.bridge.photoshop = {
      app,
      core: {
        executeAsModal: vi.fn().mockImplementation(async (callback, modalOptions) => {
          const value = await callback({ hostControl: { suspendHistory, resumeHistory } });
          if (modalOptions?.commandName === "PXD 多区拼接贴回" && options.pauseMainModal) {
            await options.pauseMainModal;
          }
          return value;
        })
      }
    };
    vi.stubGlobal("atob", vi.fn().mockImplementation((value: string) => value === "Qw==" ? "C" : "D"));
    return {
      batchPlay,
      deleted,
      featherRadii,
      scriptTokens,
      suspendHistory,
      resumeHistory,
      transforms,
      getActiveDocumentId: () => activeDocumentId,
      executeAsModal: boundary.bridge.photoshop.core.executeAsModal
    };
  };

  const createRegions = () => [
    {
      id: "one",
      documentId: 10,
      bounds: { left: 100, top: 200, right: 500, bottom: 500 },
      sourceWidth: 400,
      sourceHeight: 300,
      imageWidth: 400,
      imageHeight: 300,
      dataUrl: "data:image/png;base64,QQ==",
      encodedBytes: 1,
      selectionChannelName: "channel-one"
    },
    {
      id: "two",
      documentId: 10,
      bounds: { left: 600, top: 50, right: 800, bottom: 550 },
      sourceWidth: 200,
      sourceHeight: 500,
      imageWidth: 200,
      imageHeight: 500,
      dataUrl: "data:image/png;base64,Qg==",
      encodedBytes: 1,
      selectionChannelName: "channel-two"
    }
  ];
  const createParts = () => [
    { regionId: "one", dataUrl: "data:image/png;base64,Qw==", width: 400, height: 300, encodedBytes: 1 },
    { regionId: "two", dataUrl: "data:image/png;base64,RA==", width: 200, height: 500, encodedBytes: 1 }
  ];

  it("places smart objects at exact source bounds, groups them, and restores the active document", async () => {
    const harness = setupPlacement();
    const regions = createRegions();
    const parts = createParts();

    const result = await placeMultiRegionAtlas(10, regions, parts, {
      taskId: "atlas",
      isCurrent: () => true,
      feather: 12
    });

    expect(result).toEqual({ layerIds: [101, 102], groupId: 50 });
    expect(harness.transforms).toHaveLength(2);
    expect(harness.deleted).toEqual([]);
    expect(harness.getActiveDocumentId()).toBe(20);
    expect(harness.executeAsModal).toHaveBeenCalledTimes(1);
    expect(harness.suspendHistory).toHaveBeenCalledOnce();
    expect(harness.resumeHistory).toHaveBeenCalledOnce();
    expect(harness.featherRadii).toEqual([12, 12]);
    expect(harness.scriptTokens.filter((token) => token.includes("atlas-load-"))).toHaveLength(2);
    expect(harness.batchPlay.mock.calls.flatMap(([descriptors]) => descriptors)
      .some((descriptor: any) => descriptor.to?._obj === "rectangle")).toBe(false);
    expect(regions.every((region) => region.selectionChannelName === "")).toBe(true);
    expect(parts.every((part) => part.dataUrl === "")).toBe(true);
  });

  it("rolls back the completed group when cancellation arrives after exact selection restoration", async () => {
    let current = true;
    const harness = setupPlacement({ onRestoreSelection: () => { current = false; } });

    await expect(placeMultiRegionAtlas(10, createRegions(), createParts(), {
      taskId: "atlas",
      isCurrent: () => current
    })).rejects.toMatchObject({ name: "AtlasPlacementError" });

    expect(harness.deleted).toEqual([50]);
    expect(harness.getActiveDocumentId()).toBe(20);
  });

  it.each([
    ["transform verification", { failTransformVerification: true }],
    ["native grouping", { failGrouping: true }],
    ["history resume", { failResume: true }]
  ] as const)("rolls back layers when %s fails", async (_label, harnessOptions) => {
    const harness = setupPlacement(harnessOptions);
    await expect(placeMultiRegionAtlas(10, createRegions(), createParts(), {
      taskId: "atlas",
      isCurrent: () => true
    })).rejects.toMatchObject({ name: "AtlasPlacementError" });
    expect(harness.deleted.length).toBeGreaterThan(0);
    expect(harness.resumeHistory).toHaveBeenCalledOnce();
  });

  it("reports exact-selection cleanup failure as recovery-fatal", async () => {
    const harness = setupPlacement({ failChannelCleanup: true });
    await expect(placeMultiRegionAtlas(10, createRegions(), createParts(), {
      taskId: "atlas",
      isCurrent: () => true
    })).rejects.toMatchObject({ name: "AtlasPlacementError" });
    expect(harness.deleted).toEqual([50]);
  });

  it("keeps the caller pending through late settlement and deletes timed-out output", async () => {
    let releaseMain!: () => void;
    const pauseMainModal = new Promise<void>((resolve) => { releaseMain = resolve; });
    const harness = setupPlacement({ pauseMainModal });
    let settled = false;
    const placement = placeMultiRegionAtlas(10, createRegions(), createParts(), {
      taskId: "atlas-timeout",
      timeoutMs: 20,
      isCurrent: () => true
    }).finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 220));
    expect(settled).toBe(false);
    releaseMain();
    await expect(placement).rejects.toMatchObject({ name: "PSOperationTimeoutError" });
    expect(harness.deleted).toContain(50);
  });

  it("keeps the Photoshop circuit open when timed-out cleanup fails", async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    let releaseMain!: () => void;
    const pauseMainModal = new Promise<void>((resolve) => { releaseMain = resolve; });
    setupPlacement({ pauseMainModal, failDelete: true });
    const placement = placeMultiRegionAtlas(10, createRegions(), createParts(), {
      taskId: "atlas-cleanup-failure",
      timeoutMs: 20,
      isCurrent: () => true
    });
    await new Promise((resolve) => setTimeout(resolve, 220));
    releaseMain();
    await expect(placement).rejects.toMatchObject({ name: "PSLateCleanupError" });
    await expect(releaseAtlasRegions(createRegions(), { taskId: "blocked" }))
      .rejects.toMatchObject({ name: "PSCircuitOpenError" });
  });
});
