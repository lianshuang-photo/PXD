import { beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  bridge: {
    photoshop: null as any,
    uxp: undefined,
    getDataFolder: vi.fn(),
    createSessionToken: vi.fn()
  }
}));

vi.mock("./uxpBridge", () => ({ bridge: boundary.bridge }));

import {
  closeGeneratedDocument,
  createGeneratedDocument,
  deleteLayers,
  deleteTaskLayers,
  getActiveDocumentId,
  groupLayers
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
            { id: 2, name: "group", layers: [{ id: 3, name: "PXD 临时任务 late-task" }] }
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
