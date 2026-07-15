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
  placeMultiRegionAtlas
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
    boundary.bridge.photoshop = {
      app: {
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
      encodedBytes: 2
    });
    expect(dispose).toHaveBeenCalledOnce();
  });

  const setupPlacement = () => {
    let activeDocumentId = 20;
    let activeLayerId = 9;
    let layerBounds = { left: 0, top: 0, right: 100, bottom: 100 };
    let groupCreated = false;
    const deleted: number[] = [];
    const transforms: any[] = [];
    const sourceSelection = { left: 3, top: 4, right: 33, bottom: 44 };
    let onSelectionRestored: (() => void) | undefined;
    const batchPlay = vi.fn().mockImplementation(async (descriptors: any[]) => {
      const descriptor = descriptors[0];
      if (descriptor?._obj === "select" && descriptor._target?.[0]?._ref === "document") {
        activeDocumentId = descriptor._target[0]._id;
      } else if (descriptor?._obj === "placeEvent") {
        activeLayerId = activeLayerId === 9 ? 101 : 102;
      } else if (descriptor?._obj === "transform") {
        transforms.push(descriptor);
        const width = (layerBounds.right - layerBounds.left) * descriptor.width._value / 100;
        const height = (layerBounds.bottom - layerBounds.top) * descriptor.height._value / 100;
        const centerX = (layerBounds.left + layerBounds.right) / 2 + descriptor.offset.horizontal._value;
        const centerY = (layerBounds.top + layerBounds.bottom) / 2 + descriptor.offset.vertical._value;
        layerBounds = {
          left: centerX - width / 2,
          top: centerY - height / 2,
          right: centerX + width / 2,
          bottom: centerY + height / 2
        };
      } else if (descriptor?._obj === "AdobeScriptAutomation Scripts") {
        groupCreated = true;
        activeLayerId = 50;
      } else if (descriptor?._obj === "delete") {
        for (const item of descriptors) deleted.push(item._target[0]._id);
      } else if (descriptor?._obj === "set" && descriptor.to?._obj === "rectangle") {
        onSelectionRestored?.();
      }
      if (descriptor?._obj === "get") {
        if (groupCreated && descriptor._target?.[0]?._value === "targetEnum") {
          return [{ layerID: 50, layerSection: { _value: "layerSectionStart" } }];
        }
        return [{
          layerID: activeLayerId,
          layerKind: 5,
          smartObject: {},
          bounds: layerBounds
        }];
      }
      return [];
    });
    const sourceDocument = {
      id: 10,
      selection: { bounds: sourceSelection },
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
      createFile: vi.fn().mockResolvedValue({ write: vi.fn() })
    });
    boundary.bridge.createSessionToken.mockResolvedValue("jsx-token");
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
      core: { executeAsModal: vi.fn().mockImplementation(async (callback) => await callback()) }
    };
    vi.stubGlobal("atob", vi.fn().mockReturnValue("A"));
    return {
      deleted,
      transforms,
      setOnSelectionRestored: (callback: () => void) => { onSelectionRestored = callback; },
      getActiveDocumentId: () => activeDocumentId
    };
  };

  const regions = [
    {
      id: "one",
      documentId: 10,
      bounds: { left: 100, top: 200, right: 500, bottom: 500 },
      sourceWidth: 400,
      sourceHeight: 300,
      imageWidth: 400,
      imageHeight: 300,
      dataUrl: "data:image/png;base64,QQ==",
      encodedBytes: 1
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
      encodedBytes: 1
    }
  ];
  const parts = [
    { regionId: "one", dataUrl: "data:image/png;base64,Qw==", width: 400, height: 300 },
    { regionId: "two", dataUrl: "data:image/png;base64,RA==", width: 200, height: 500 }
  ];

  it("places smart objects at exact source bounds, groups them, and restores the active document", async () => {
    const harness = setupPlacement();

    const result = await placeMultiRegionAtlas(10, regions, parts, {
      taskId: "atlas",
      isCurrent: () => true
    });

    expect(result).toEqual({ layerIds: [101, 102], groupId: 50 });
    expect(harness.transforms).toHaveLength(2);
    expect(harness.deleted).toEqual([]);
    expect(harness.getActiveDocumentId()).toBe(20);
  });

  it("rolls back the completed group when cancellation arrives during restoration", async () => {
    const harness = setupPlacement();
    let current = true;
    harness.setOnSelectionRestored(() => { current = false; });

    await expect(placeMultiRegionAtlas(10, regions, parts, {
      taskId: "atlas",
      isCurrent: () => current
    })).rejects.toMatchObject({ name: "AtlasPlacementError" });

    expect(harness.deleted).toEqual([50]);
    expect(harness.getActiveDocumentId()).toBe(20);
  });
});
