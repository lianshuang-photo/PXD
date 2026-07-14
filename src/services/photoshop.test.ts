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
  createGeneratedDocument,
  getDocumentPixels,
  getSelectionMetadata,
  groupLayers,
  placeImageIntoDocumentBounds
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
