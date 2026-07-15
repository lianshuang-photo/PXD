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
  captureSceneSource,
  closeGeneratedDocument,
  createGeneratedDocument,
  groupLayers,
  placeSceneBackground,
  type SceneSourceCapture
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

describe("scene Photoshop adapters", () => {
  const capture: SceneSourceCapture = {
    documentId: 10,
    documentWidth: 2000,
    documentHeight: 1000,
    baseImageDataUrl: "data:image/png;base64,QUJD",
    baseWidth: 1024,
    baseHeight: 512,
    selectionBounds: { left: 100, top: 100, right: 700, bottom: 900 },
    referenceImageDataUrl: "data:image/png;base64,REVG",
    selectionChannelName: "__PXD_SCENE_TEST"
  };

  it("captures bounded canvas/reference images sequentially and disposes both pixel buffers", async () => {
    const disposes = [vi.fn(), vi.fn()];
    const getPixels = vi.fn()
      .mockResolvedValueOnce({ imageData: { dispose: disposes[0] } })
      .mockResolvedValueOnce({ imageData: { dispose: disposes[1] } });
    const encodeImageData = vi.fn()
      .mockResolvedValueOnce("QUJD")
      .mockResolvedValueOnce("REVG");
    boundary.bridge.photoshop = {
      app: {
        activeDocument: {
          id: 10,
          width: { value: 2000 },
          height: { value: 1000 },
          selection: { bounds: { left: 100, top: 100, right: 700, bottom: 900 } }
        }
      },
      imaging: { getPixels, encodeImageData },
      core: { executeAsModal: vi.fn().mockImplementation(async (callback) => await callback()) }
    };

    const result = await captureSceneSource({
      maxEdge: 1024,
      includeSelection: true,
      preserveSelection: false,
      maxInputBytes: 4 * 1024 * 1024
    });

    expect(getPixels).toHaveBeenNthCalledWith(1, expect.objectContaining({
      sourceBounds: { left: 0, top: 0, right: 2000, bottom: 1000 },
      targetSize: { width: 1024, height: 512 }
    }));
    expect(getPixels).toHaveBeenNthCalledWith(2, expect.objectContaining({
      sourceBounds: { left: 100, top: 100, right: 700, bottom: 900 },
      targetSize: { width: 600, height: 800 }
    }));
    expect(disposes[0]).toHaveBeenCalledOnce();
    expect(disposes[1]).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      baseImageDataUrl: "data:image/png;base64,QUJD",
      referenceImageDataUrl: "data:image/png;base64,REVG"
    });
  });

  const setupPlacement = (failTransform = false, failDelete = false) => {
    const deleted: number[] = [];
    const maskModes: string[] = [];
    const file = { write: vi.fn() };
    boundary.bridge.getDataFolder.mockResolvedValue({
      createFile: vi.fn().mockResolvedValue(file)
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
    const batchPlay = vi.fn().mockImplementation(async (descriptors: any[]) => {
      const descriptor = descriptors[0];
      if (descriptor?._obj === "placeEvent") return [];
      if (descriptor?._obj === "transform") {
        if (failTransform) throw new Error("transform failed");
        return [];
      }
      if (descriptor?._obj === "get" && descriptor._target?.[0]?._id === 42) {
        const getCount = batchPlay.mock.calls.filter(([items]) => items[0]?._obj === "get").length;
        if (getCount === 1) {
          return [{
            layerID: 42,
            bounds: {
              left: { _value: 0 }, top: { _value: 0 },
              right: { _value: 1000 }, bottom: { _value: 1000 }
            }
          }];
        }
        return [{
          hasUserMask: true,
          bounds: {
            left: { _value: 0 }, top: { _value: 0 },
            right: { _value: 2000 }, bottom: { _value: 1000 }
          }
        }];
      }
      if (descriptor?._obj === "get") {
        return [{
          layerID: 42,
          bounds: {
            left: { _value: 0 }, top: { _value: 0 },
            right: { _value: 1000 }, bottom: { _value: 1000 }
          }
        }];
      }
      if (descriptor?._obj === "make") maskModes.push(descriptor.using?._value);
      if (descriptor?._obj === "delete") {
        if (failDelete) throw new Error("delete failed");
        deleted.push(descriptor._target[0]._id);
      }
      return [{}];
    });
    boundary.bridge.photoshop = {
      app: { batchPlay, activeDocument: { id: 10 } },
      core: { executeAsModal: vi.fn().mockImplementation(async (callback) => await callback()) }
    };
    return { batchPlay, deleted, maskModes };
  };

  it("strictly fills the canvas and hides the generated layer inside the stored subject selection", async () => {
    const harness = setupPlacement();
    const result = await placeSceneBackground(capture, "data:image/png;base64,T1VU", {
      protectSubject: true,
      layerName: "PXD Scene",
      isCurrent: () => true
    });
    expect(result).toEqual({ layerId: 42 });
    expect(harness.maskModes).toContain("hideSelection");
    expect(harness.deleted).toEqual([]);
  });

  it("deletes the known landed layer when strict transform fails", async () => {
    const harness = setupPlacement(true);
    await expect(placeSceneBackground(capture, "data:image/png;base64,T1VU", {
      protectSubject: false,
      layerName: "PXD Scene",
      isCurrent: () => true
    })).rejects.toThrow("transform failed");
    expect(harness.deleted).toEqual([42]);
  });

  it("marks a failed landed-layer rollback as a recovery failure", async () => {
    setupPlacement(true, true);
    await expect(placeSceneBackground(capture, "data:image/png;base64,T1VU", {
      protectSubject: false,
      layerName: "PXD Scene",
      isCurrent: () => true
    })).rejects.toMatchObject({
      name: "ScenePhotoshopError",
      recoveryFailed: true
    });
  });
});
