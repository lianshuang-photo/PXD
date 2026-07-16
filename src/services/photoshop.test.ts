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
  closeGeneratedDocument,
  computeSelectionCaptureSize,
  createGeneratedDocument,
  deleteLayers,
  deleteLayersInDocument,
  deleteTaskLayers,
  getActiveDocumentId,
  getDocumentPixels,
  getSelectionMetadata,
  getSelectionPixels,
  groupLayers,
  isPhotoshopPartialPlacementError,
  placeImageIntoDocumentBounds,
  placeImageIntoSelection
} from "./photoshop";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("tiled upscale Photoshop adapters", () => {
  it("reads selection metadata and bounded pixels without exporting the whole selection", async () => {
    const dispose = vi.fn();
    const getPixels = vi.fn().mockResolvedValue({ imageData: { dispose } });
    const encodeImageData = vi.fn().mockResolvedValue("TILE");
    boundary.bridge.photoshop = {
      app: {
        activeDocument: {
          id: 7,
          selection: { bounds: { left: 10, top: 20, right: 2010, bottom: 1220 } }
        }
      },
      imaging: { getPixels, encodeImageData },
      core: { executeAsModal: vi.fn().mockImplementation(async (callback) => await callback()) }
    };

    await expect(getSelectionMetadata()).resolves.toEqual({
      documentId: 7,
      width: 2000,
      height: 1200,
      selectionBounds: { left: 10, top: 20, right: 2010, bottom: 1220 }
    });
    await expect(getDocumentPixels(7, { left: 100, top: 200, right: 612, bottom: 712 }))
      .resolves.toBe("data:image/png;base64,TILE");
    expect(getPixels).toHaveBeenCalledWith(expect.objectContaining({
      documentID: 7,
      sourceBounds: { left: 100, top: 200, right: 612, bottom: 712 }
    }));
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("places and transforms a feathered tile to exact output bounds", async () => {
    const file = { write: vi.fn().mockResolvedValue(undefined) };
    boundary.bridge.uxp = {
      storage: {
        formats: { binary: "binary" },
        localFileSystem: {
          getTemporaryFolder: vi.fn().mockResolvedValue({ createFile: vi.fn().mockResolvedValue(file) }),
          createSessionToken: vi.fn().mockResolvedValue("token")
        }
      }
    };
    const info = {
      layerID: 42,
      bounds: {
        left: { _value: 100 },
        top: { _value: 50 },
        right: { _value: 612 },
        bottom: { _value: 562 }
      }
    };
    const batchPlay = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([info])
      .mockResolvedValueOnce([]);
    boundary.bridge.photoshop = {
      app: { activeDocument: { id: 9 }, batchPlay },
      core: { executeAsModal: vi.fn().mockImplementation(async (callback) => await callback()) }
    };

    await expect(placeImageIntoDocumentBounds(
      "data:image/png;base64,QQ==",
      { left: 0, top: 0, right: 1024, bottom: 768 },
      1,
      9
    )).resolves.toBe(info);

    expect(batchPlay.mock.calls[2][0][0]).toMatchObject({
      _obj: "transform",
      _target: [{ _ref: "layer", _id: 42 }],
      width: { _unit: "percentUnit", _value: 200 },
      height: { _unit: "percentUnit", _value: 150 },
      offset: {
        horizontal: { _unit: "pixelsUnit", _value: 156 },
        vertical: { _unit: "pixelsUnit", _value: 78 }
      }
    });
  });
});

const setupPlacement = (
  batchPlay: ReturnType<typeof vi.fn>,
  options: { withSelection?: boolean } = {}
) => {
  const withSelection = options.withSelection ?? true;
  const file = { write: vi.fn().mockResolvedValue(undefined) };
  boundary.bridge.uxp = {
    storage: {
      formats: { binary: "binary" },
      localFileSystem: {
        getTemporaryFolder: vi.fn().mockResolvedValue({
          createFile: vi.fn().mockResolvedValue(file)
        }),
        createSessionToken: vi.fn().mockResolvedValue("temp-token")
      }
    }
  };
  boundary.bridge.photoshop = {
    app: {
      batchPlay,
      activeDocument: withSelection
        ? {
            id: 9,
            selection: { bounds: { left: 0, top: 0, right: 64, bottom: 64 } }
          }
        : { id: 9 }
    },
    core: { executeAsModal: vi.fn().mockImplementation(async (callback) => await callback()) }
  };
};

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

  it("reads the active document and deletes only requested rollback layers", async () => {
    const batchPlay = vi.fn().mockResolvedValue([]);
    boundary.bridge.photoshop = {
      app: { batchPlay, activeDocument: { id: 88 } },
      core: { executeAsModal: vi.fn().mockImplementation(async (callback) => await callback()) }
    };

    await expect(getActiveDocumentId()).resolves.toBe(88);
    await deleteLayers([301, 302, 301, 0]);

    expect(batchPlay).toHaveBeenCalledWith([
      { _obj: "delete", _target: [{ _ref: "layer", _id: 301 }] },
      { _obj: "delete", _target: [{ _ref: "layer", _id: 302 }] }
    ], {});
  });

  it("finds and deletes late placed layers by task marker", async () => {
    const batchPlay = vi.fn().mockResolvedValue([]);
    boundary.bridge.photoshop = {
      app: {
        batchPlay,
        activeDocument: {
          id: 88,
          layers: [
            { id: 1, name: "keep" },
            { id: 2, name: "group", layers: [{ id: 3, name: "PXD 临时任务 late-task" }] },
            { id: 4, name: "PXD 临时任务 other-task" }
          ]
        }
      },
      core: { executeAsModal: vi.fn().mockImplementation(async (callback) => await callback()) }
    };

    await deleteTaskLayers("late-task");
    expect(batchPlay).toHaveBeenCalledWith([
      { _obj: "delete", _target: [{ _ref: "layer", _id: 3 }] }
    ], {});
  });

  it("deletes a marked group without also deleting its marked children", async () => {
    const batchPlay = vi.fn().mockResolvedValue([]);
    boundary.bridge.photoshop = {
      app: {
        batchPlay,
        activeDocument: {
          id: 88,
          layers: [{
            id: 2,
            name: "PXD 临时任务 grouped-task",
            layers: [{ id: 3, name: "PXD 临时任务 grouped-task" }]
          }]
        }
      },
      core: { executeAsModal: vi.fn().mockImplementation(async (callback) => await callback()) }
    };

    await deleteTaskLayers("grouped-task");
    expect(batchPlay).toHaveBeenCalledWith([
      { _obj: "delete", _target: [{ _ref: "layer", _id: 2 }] }
    ], {});
  });
});

describe("placeImageIntoSelection partial placement", () => {
  it("carries the placed layer id when the later active-layer get fails", async () => {
    const getFailure = new Error("get target failed");
    const batchPlay = vi.fn()
      .mockResolvedValueOnce([{ layerID: 42 }])
      .mockRejectedValueOnce(getFailure);
    setupPlacement(batchPlay);

    await expect(placeImageIntoSelection("data:image/png;base64,QQ=="))
      .rejects.toMatchObject({
        name: "PhotoshopPartialPlacementError",
        placedLayerId: 42,
        originalError: getFailure
      });
  });

  it("carries the placed layer id when writing the task marker fails", async () => {
    const markerFailure = new Error("marker write failed");
    const batchPlay = vi.fn()
      .mockResolvedValueOnce([{ layerID: 43 }])
      .mockRejectedValueOnce(markerFailure);
    setupPlacement(batchPlay, { withSelection: false });

    await expect(placeImageIntoSelection("data:image/png;base64,QQ==", 1, { taskId: "task-43" }))
      .rejects.toMatchObject({
        name: "PhotoshopPartialPlacementError",
        placedLayerId: 43,
        originalError: markerFailure
      });
    expect(batchPlay.mock.calls[1][0][0]).toMatchObject({
      _obj: "set",
      _target: [{ _ref: "layer", _id: 43 }]
    });
  });

  it("does not report a layer id when placeEvent itself fails", async () => {
    const placeFailure = new Error("place failed");
    setupPlacement(vi.fn().mockRejectedValueOnce(placeFailure));

    const caught = await placeImageIntoSelection("data:image/png;base64,QQ==").catch((error) => error);

    expect(caught).toBe(placeFailure);
    expect(isPhotoshopPartialPlacementError(caught)).toBe(false);
  });
});

describe("Photoshop selection capture", () => {
  it("requests scaled pixels before encoding a large reference selection", async () => {
    const getPixels = vi.fn().mockResolvedValue({ imageData: { dispose: vi.fn() } });
    const encodeImageData = vi.fn().mockResolvedValue("CAPTURED");
    boundary.bridge.photoshop = {
      app: {
        activeDocument: {
          id: 7,
          selection: { bounds: { left: 10, top: 20, right: 2010, bottom: 1020 } }
        }
      },
      core: { executeAsModal: vi.fn().mockImplementation(async (callback) => await callback()) },
      imaging: { getPixels, encodeImageData }
    };

    const result = await getSelectionPixels({ maxEdge: 768 });

    expect(getPixels).toHaveBeenCalledWith(expect.objectContaining({
      documentID: 7,
      sourceBounds: { left: 10, top: 20, right: 2010, bottom: 1020 },
      targetSize: { width: 768, height: 384 }
    }));
    expect(result).toEqual({
      dataUrl: "data:image/png;base64,CAPTURED",
      width: 2000,
      height: 1000,
      documentId: 7,
      selectionBounds: { left: 10, top: 20, right: 2010, bottom: 1020 }
    });
  });

  it("does not upscale selections that already fit the requested edge", () => {
    expect(computeSelectionCaptureSize(320, 200, 768)).toEqual({ width: 320, height: 200 });
  });

  it("disposes captured image data when encoding fails", async () => {
    const dispose = vi.fn();
    boundary.bridge.photoshop = {
      app: {
        activeDocument: {
          id: 7,
          selection: { bounds: { left: 0, top: 0, right: 100, bottom: 100 } }
        }
      },
      core: { executeAsModal: vi.fn().mockImplementation(async (callback) => await callback()) },
      imaging: {
        getPixels: vi.fn().mockResolvedValue({ imageData: { dispose } }),
        encodeImageData: vi.fn().mockRejectedValue(new Error("encode failed"))
      }
    };
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(getSelectionPixels({ maxEdge: 768 })).resolves.toBeNull();
    expect(dispose).toHaveBeenCalledOnce();
    errorLog.mockRestore();
  });
});

describe("deleteLayersInDocument", () => {
  it("deletes each unique valid generated layer in one modal transaction", async () => {
    const batchPlay = vi.fn().mockResolvedValue([]);
    const executeAsModal = vi.fn().mockImplementation(async (callback) => await callback());
    boundary.bridge.photoshop = {
      app: { batchPlay, activeDocument: { id: 1 } },
      core: { executeAsModal }
    };

    await deleteLayersInDocument(1, [42, 42, -1, Number.NaN, 77]);

    expect(batchPlay).toHaveBeenCalledWith([
      { _obj: "delete", _target: [{ _ref: "layer", _id: 42 }] },
      { _obj: "delete", _target: [{ _ref: "layer", _id: 77 }] }
    ], { synchronousExecution: true });
    expect(executeAsModal).toHaveBeenCalledWith(expect.any(Function), {
      commandName: "撤销 PXD 海报生成"
    });
  });

  it("deletes colliding layer ids only in the source document and restores the user's document", async () => {
    let activeDocumentId = 20;
    const layersByDocument = new Map([
      [10, new Set([42])],
      [20, new Set([42])]
    ]);
    const batchPlay = vi.fn().mockImplementation(async (descriptors: any[]) => {
      for (const descriptor of descriptors) {
        if (descriptor._obj === "select" && descriptor._target?.[0]?._ref === "document") {
          activeDocumentId = descriptor._target[0]._id;
        }
        if (descriptor._obj === "delete") {
          layersByDocument.get(activeDocumentId)?.delete(descriptor._target[0]._id);
        }
      }
      return [];
    });
    boundary.bridge.photoshop = {
      app: {
        batchPlay,
        get activeDocument() {
          return { id: activeDocumentId };
        }
      },
      core: { executeAsModal: vi.fn().mockImplementation(async (callback) => await callback()) }
    };

    await deleteLayersInDocument(10, [42]);

    expect(layersByDocument.get(10)?.has(42)).toBe(false);
    expect(layersByDocument.get(20)?.has(42)).toBe(true);
    expect(activeDocumentId).toBe(20);
    expect(batchPlay.mock.calls.map(([descriptors]) => descriptors[0])).toEqual([
      { _obj: "select", _target: [{ _ref: "document", _id: 10 }] },
      { _obj: "delete", _target: [{ _ref: "layer", _id: 42 }] },
      { _obj: "select", _target: [{ _ref: "document", _id: 20 }] }
    ]);
  });

  it("surfaces Photoshop deletion failures", async () => {
    const failure = new Error("layer is locked");
    boundary.bridge.photoshop = {
      app: { batchPlay: vi.fn().mockRejectedValue(failure), activeDocument: { id: 1 } },
      core: { executeAsModal: vi.fn().mockImplementation(async (callback) => await callback()) }
    };

    await expect(deleteLayersInDocument(1, [42])).rejects.toBe(failure);
  });
});

describe("placeImageIntoSelection partial placement", () => {
  it("reports the placed layer before a later selection descriptor fails", async () => {
    const selectionFailure = new Error("selection restore failed");
    const batchPlay = vi.fn()
      .mockResolvedValueOnce([{ layerID: 42 }])
      .mockRejectedValueOnce(selectionFailure);
    setupPlacement(batchPlay);
    const onLayerPlaced = vi.fn();

    const operation = placeImageIntoSelection("data:image/png;base64,QQ==", 1, { onLayerPlaced });

    await expect(operation).rejects.toMatchObject({
      name: "PhotoshopPartialPlacementError",
      placedLayerId: 42,
      originalError: selectionFailure
    });
    expect(onLayerPlaced).toHaveBeenCalledWith(42);
    expect(batchPlay.mock.calls[0][0]).toEqual([expect.objectContaining({ _obj: "placeEvent" })]);
    expect(batchPlay.mock.calls[1][0]).toEqual([expect.objectContaining({ _obj: "set" })]);
  });

  it("carries the already reported layer id when the active-layer get fails", async () => {
    const getFailure = new Error("get target failed");
    const batchPlay = vi.fn()
      .mockResolvedValueOnce([{ layerID: 43 }])
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(getFailure);
    setupPlacement(batchPlay);
    const onLayerPlaced = vi.fn();

    await expect(placeImageIntoSelection("data:image/png;base64,QQ==", 1, {
      onLayerPlaced
    })).rejects.toMatchObject({
      name: "PhotoshopPartialPlacementError",
      placedLayerId: 43,
      originalError: getFailure
    });

    expect(onLayerPlaced).toHaveBeenCalledWith(43);
    expect(onLayerPlaced).toHaveBeenCalledOnce();
    expect(batchPlay.mock.calls[2][0][0]).toMatchObject({ _obj: "get" });
  });

  it("does not report a layer when placeEvent itself fails", async () => {
    const placeFailure = new Error("place failed");
    const batchPlay = vi.fn().mockRejectedValueOnce(placeFailure);
    setupPlacement(batchPlay);
    const onLayerPlaced = vi.fn();

    const caught = await placeImageIntoSelection(
      "data:image/png;base64,QQ==",
      1,
      { onLayerPlaced }
    ).catch((error) => error);

    expect(caught).toBe(placeFailure);
    expect(isPhotoshopPartialPlacementError(caught)).toBe(false);
    expect(onLayerPlaced).not.toHaveBeenCalled();
  });
});
