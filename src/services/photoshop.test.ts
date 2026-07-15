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
  captureVfxSource,
  closeGeneratedDocument,
  createGeneratedDocument,
  groupLayers,
  placeVfxResult,
  validateVfxSource,
  type VfxSource
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

describe("vfx Photoshop boundaries", () => {
  const fullSource: VfxSource = {
    dataUrl: "data:image/png;base64,c291cmNl",
    documentId: 7,
    documentWidth: 100,
    documentHeight: 80,
    selectionBounds: null
  };

  const preparePlacementBoundary = () => {
    const suspendHistory = vi.fn().mockResolvedValue("history-token");
    const resumeHistory = vi.fn().mockResolvedValue(undefined);
    const activeDocument: any = { id: 7, width: 100, height: 80, selection: {}, activeLayer: { id: 5 } };
    const batchPlay = vi.fn().mockImplementation(async (commands: any[]) => {
      if (commands[0]?._obj === "placeEvent") {
        activeDocument.activeLayer = { id: 42 };
        return [{ layerID: 42 }];
      }
      if (commands[0]?._obj === "get") {
        return [{ layerID: 42, bounds: { left: 0, top: 0, right: 50, bottom: 40 } }];
      }
      if (commands[0]?._obj === "delete") activeDocument.activeLayer = { id: 5 };
      return [];
    });
    boundary.bridge.uxp = {
      storage: {
        formats: { binary: "binary" },
        localFileSystem: {
          getTemporaryFolder: vi.fn().mockResolvedValue({
            createFile: vi.fn().mockResolvedValue({ write: vi.fn().mockResolvedValue(undefined) })
          }),
          createSessionToken: vi.fn().mockResolvedValue("token")
        }
      }
    };
    boundary.bridge.photoshop = {
      app: { activeDocument, batchPlay },
      core: {
        executeAsModal: vi.fn().mockImplementation(async (callback) => await callback({
          hostControl: { suspendHistory, resumeHistory }
        }))
      }
    };
    return { activeDocument, batchPlay, suspendHistory, resumeHistory };
  };

  it("captures the whole canvas and always disposes image data", async () => {
    const dispose = vi.fn();
    const getPixels = vi.fn().mockResolvedValue({ imageData: { dispose } });
    const encodeImageData = vi.fn().mockResolvedValue("ZnVsbA==");
    boundary.bridge.photoshop = {
      app: { activeDocument: { id: 7, width: 100, height: 80, selection: {} }, batchPlay: vi.fn() },
      core: { executeAsModal: vi.fn().mockImplementation(async (callback) => await callback()) },
      imaging: { getPixels, encodeImageData }
    };
    await expect(captureVfxSource()).resolves.toEqual({
      ...fullSource,
      dataUrl: "data:image/png;base64,ZnVsbA=="
    });
    expect(getPixels).toHaveBeenCalledWith(expect.objectContaining({
      documentID: 7,
      sourceBounds: { left: 0, top: 0, right: 100, bottom: 80 }
    }));
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("captures only the active selection and disposes on encode failure", async () => {
    const dispose = vi.fn();
    boundary.bridge.photoshop = {
      app: {
        activeDocument: {
          id: 7, width: 100, height: 80,
          selection: { bounds: { left: 10, top: 12, right: 60, bottom: 52 } }
        },
        batchPlay: vi.fn()
      },
      core: { executeAsModal: vi.fn().mockImplementation(async (callback) => await callback()) },
      imaging: {
        getPixels: vi.fn().mockResolvedValue({ imageData: { dispose } }),
        encodeImageData: vi.fn().mockRejectedValue(new Error("encode failed"))
      }
    };
    await expect(captureVfxSource()).rejects.toThrow("encode failed");
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("rejects a changed source document or canvas", async () => {
    boundary.bridge.photoshop = {
      app: { activeDocument: { id: 8, width: 100, height: 80 }, batchPlay: vi.fn() },
      core: { executeAsModal: vi.fn().mockImplementation(async (callback) => await callback()) }
    };
    await expect(validateVfxSource(fullSource)).rejects.toThrow("活动文档已切换");
    boundary.bridge.photoshop.app.activeDocument = { id: 7, width: 101, height: 80 };
    await expect(validateVfxSource(fullSource)).rejects.toThrow("画布尺寸已变化");
  });

  it("places a full-canvas result in one history step and restores no selection", async () => {
    const { batchPlay, suspendHistory, resumeHistory } = preparePlacementBoundary();
    await expect(placeVfxResult(
      fullSource,
      "data:image/png;base64,cmVzdWx0",
      { blendMode: "screen", useSelectionMask: true },
      () => true
    ))
      .resolves.toEqual({ layerId: 42 });
    expect(suspendHistory).toHaveBeenCalledWith({ documentID: 7, name: "AI VFX 特效" });
    expect(resumeHistory).toHaveBeenCalledWith("history-token");
    const descriptors = batchPlay.mock.calls.flatMap((call) => call[0]);
    expect(descriptors).toContainEqual(expect.objectContaining({
      _obj: "set",
      to: { _enum: "ordinal", _value: "none" }
    }));
    expect(descriptors.some((descriptor) => descriptor._obj === "make")).toBe(false);
    expect(descriptors).toContainEqual(expect.objectContaining({
      _obj: "set",
      to: expect.objectContaining({
        name: "AI VFX 特效",
        mode: { _enum: "blendMode", _value: "screen" }
      })
    }));
  });

  it("masks a selection result, restores its bounds, and deletes the exact layer on cancellation", async () => {
    const { activeDocument, batchPlay } = preparePlacementBoundary();
    const selectionBounds = { left: 10, top: 12, right: 60, bottom: 52 };
    activeDocument.selection = { bounds: selectionBounds };
    const current = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    await expect(placeVfxResult(
      { ...fullSource, selectionBounds },
      "data:image/png;base64,cmVzdWx0",
      { blendMode: "linearDodge", useSelectionMask: true },
      current
    )).rejects.toThrow("VFX_CANCELLED");
    const descriptors = batchPlay.mock.calls.flatMap((call) => call[0]);
    expect(descriptors).toContainEqual(expect.objectContaining({
      _obj: "make",
      using: { _enum: "userMaskEnabled", _value: "revealSelection" }
    }));
    expect(descriptors).toContainEqual(expect.objectContaining({
      _obj: "set",
      to: expect.objectContaining({ _obj: "rectangle" })
    }));
    expect(descriptors).toContainEqual({
      _obj: "delete",
      _target: [{ _ref: "layer", _id: 42 }]
    });
    expect(descriptors).toContainEqual(expect.objectContaining({
      _obj: "set",
      to: expect.objectContaining({
        mode: { _enum: "blendMode", _value: "linearDodge" }
      })
    }));
  });

  it("deletes an exact layer returned after a Photoshop timeout", async () => {
    const { activeDocument, batchPlay } = preparePlacementBoundary();
    let releaseModal!: () => void;
    const modalGate = new Promise<void>((resolve) => { releaseModal = resolve; });
    boundary.bridge.photoshop.core.executeAsModal.mockImplementation(async (callback: any, options: any) => {
      const result = await callback({
        hostControl: {
          suspendHistory: vi.fn().mockResolvedValue("history-token"),
          resumeHistory: vi.fn().mockResolvedValue(undefined)
        }
      });
      if (options?.commandName === "AI VFX 特效贴回") await modalGate;
      return result;
    });
    const timedOut = placeVfxResult(
      fullSource,
      "data:image/png;base64,cmVzdWx0",
      { blendMode: "screen", useSelectionMask: true },
      () => true,
      { taskId: "late-vfx", timeoutMs: 20 }
    );
    await expect(timedOut).rejects.toMatchObject({ name: "PSOperationTimeoutError" });
    expect(activeDocument.activeLayer.id).toBe(42);
    releaseModal();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const deletes = batchPlay.mock.calls
      .flatMap((call) => call[0])
      .filter((descriptor) => descriptor._obj === "delete");
    expect(deletes).toContainEqual({
      _obj: "delete",
      _target: [{ _ref: "layer", _id: 42 }]
    });
    expect(activeDocument.activeLayer.id).toBe(5);
  });
});
