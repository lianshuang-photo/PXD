import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGlobalPartitionPlan } from "./globalPartition";

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
  captureDocumentRegions,
  closeGeneratedDocument,
  createGeneratedDocument,
  groupLayers,
  placePartitionedImages
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

describe("global partition Photoshop primitives", () => {
  it("captures scaled regions, disposes imaging buffers, and restores the active document", async () => {
    const plan = createGlobalPartitionPlan({
      width: 2000,
      height: 1000,
      overlap: 80,
      targetMaxEdge: 768
    });
    let activeDocumentId = 20;
    const batchPlay = vi.fn().mockImplementation(async (descriptors: any[]) => {
      const descriptor = descriptors[0];
      if (descriptor?._obj === "select" && descriptor._target?.[0]?._ref === "document") {
        activeDocumentId = descriptor._target[0]._id;
      }
      return [{}];
    });
    const disposes = plan.tiles.map(() => vi.fn());
    const getPixels = vi.fn().mockImplementation(async () => ({
      imageData: { dispose: disposes[getPixels.mock.calls.length - 1] }
    }));
    const encodeImageData = vi.fn()
      .mockResolvedValueOnce("LEFT")
      .mockResolvedValueOnce("RIGHT");
    boundary.bridge.photoshop = {
      app: {
        batchPlay,
        get activeDocument() {
          return { id: activeDocumentId };
        }
      },
      imaging: { getPixels, encodeImageData },
      core: { executeAsModal: vi.fn().mockImplementation(async (callback) => await callback()) }
    };

    const captures = await captureDocumentRegions(10, plan.tiles, { taskId: "partition" });

    expect(captures.map(({ tileId, dataUrl }) => ({ tileId, dataUrl }))).toEqual([
      { tileId: "left", dataUrl: "data:image/png;base64,LEFT" },
      { tileId: "right", dataUrl: "data:image/png;base64,RIGHT" }
    ]);
    expect(getPixels).toHaveBeenCalledTimes(2);
    for (let index = 0; index < plan.tiles.length; index += 1) {
      expect(getPixels).toHaveBeenNthCalledWith(index + 1, expect.objectContaining({
        documentID: 10,
        sourceBounds: plan.tiles[index].captureBounds,
        targetSize: {
          width: plan.tiles[index].targetWidth,
          height: plan.tiles[index].targetHeight
        }
      }));
      expect(disposes[index]).toHaveBeenCalledOnce();
    }
    expect(activeDocumentId).toBe(20);
  });

  const setupPartitionPlacement = (
    configuration: { failGroupGet?: boolean; selectionReadFails?: boolean } = {}
  ) => {
    let activeDocumentId = 20;
    let activeLayerId = 5;
    let activeLayerIsGroup = false;
    let sourceSelection: any = { left: 3, top: 4, right: 50, bottom: 60 };
    let lastJsx = "";
    const deleted: number[] = [];
    const file = {
      write: vi.fn().mockImplementation(async (value: string) => {
        lastJsx = value;
      })
    };
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
    let nextPlacedLayerId = 41;
    const batchPlay = vi.fn().mockImplementation(async (descriptors: any[]) => {
      const descriptor = descriptors[0];
      if (descriptor?._obj === "select" && descriptor._target?.[0]?._ref === "document") {
        activeDocumentId = descriptor._target[0]._id;
      } else if (descriptor?._obj === "placeEvent") {
        activeLayerId = nextPlacedLayerId++;
        activeLayerIsGroup = false;
      } else if (descriptor?._obj === "AdobeScriptAutomation Scripts") {
        if (lastJsx.includes("layerSection")) {
          activeLayerId = 50;
          activeLayerIsGroup = true;
        }
      } else if (descriptor?._obj === "set" && descriptor._target?.[0]?._property === "selection") {
        sourceSelection = descriptor.to?._obj === "rectangle"
          ? {
              left: descriptor.to.left._value,
              top: descriptor.to.top._value,
              right: descriptor.to.right._value,
              bottom: descriptor.to.bottom._value
            }
          : null;
      } else if (descriptor?._obj === "delete") {
        for (const item of descriptors) deleted.push(item._target[0]._id);
      }
      if (descriptor?._obj === "get" && descriptor._target?.[0]?._ref === "layer") {
        if (activeLayerIsGroup && configuration.failGroupGet) throw new Error("group get failed");
        return [{
          layerID: activeLayerId,
          layerSection: { _value: activeLayerIsGroup ? "layerSectionStart" : "layerSectionContent" }
        }];
      }
      return descriptors.map(() => ({}));
    });
    boundary.bridge.photoshop = {
      app: {
        batchPlay,
        get activeDocument() {
          return {
            id: activeDocumentId,
            get activeLayer() {
              return { id: activeLayerId };
            },
            get activeLayers() {
              return [{ id: activeLayerId }];
            },
            selection: {
              get bounds() {
                if (configuration.selectionReadFails) throw new Error("selection unavailable");
                return sourceSelection;
              }
            }
          };
        }
      },
      core: { executeAsModal: vi.fn().mockImplementation(async (callback) => await callback()) }
    };
    return {
      batchPlay,
      deleted,
      file,
      getActiveDocumentId: () => activeDocumentId,
      getSelection: () => sourceSelection
    };
  };

  it("places non-destructive feathered tiles, groups them, and restores document state", async () => {
    const harness = setupPartitionPlacement();
    const originalSelection = { left: 3, top: 4, right: 50, bottom: 60 };
    const plan = createGlobalPartitionPlan({
      width: 2000,
      height: 1000,
      overlap: 80,
      targetMaxEdge: 768
    });

    const result = await placePartitionedImages(
      10,
      plan.tiles.map((tile) => ({ tile, dataUrl: "data:image/png;base64,QQ==" })),
      {
        taskId: "partition",
        maskContract: 12,
        maskFeather: 24,
        isCurrent: () => true
      }
    );

    expect(result).toEqual({ layerIds: [41, 42], groupId: 50 });
    expect(harness.deleted).toEqual([]);
    expect(harness.getActiveDocumentId()).toBe(20);
    expect(harness.getSelection()).toEqual(originalSelection);
    expect(harness.file.write.mock.calls.some(([jsx]) => String(jsx).includes("selection.contract(12)")))
      .toBe(true);
    expect(harness.file.write.mock.calls.some(([jsx]) => String(jsx).includes("selection.feather(24)")))
      .toBe(true);
  });

  it("deletes only landed partition layers when cancellation arrives during placement", async () => {
    const harness = setupPartitionPlacement();
    const plan = createGlobalPartitionPlan({
      width: 1000,
      height: 1000,
      overlap: 80,
      targetMaxEdge: 768
    });
    let current = true;

    await expect(placePartitionedImages(
      10,
      [{ tile: plan.tiles[0], dataUrl: "data:image/png;base64,QQ==" }],
      {
        taskId: "partition",
        maskContract: 12,
        maskFeather: 24,
        isCurrent: () => current,
        onProgress: () => {
          current = false;
        }
      }
    )).rejects.toThrow("已取消");

    expect(harness.deleted).toEqual([41]);
    expect(harness.getActiveDocumentId()).toBe(20);
  });

  it("removes a newly created group when strict group verification fails", async () => {
    const harness = setupPartitionPlacement({ failGroupGet: true });
    const plan = createGlobalPartitionPlan({
      width: 1000,
      height: 1000,
      overlap: 80,
      targetMaxEdge: 768
    });

    await expect(placePartitionedImages(
      10,
      [{ tile: plan.tiles[0], dataUrl: "data:image/png;base64,QQ==" }],
      {
        taskId: "partition",
        maskContract: 12,
        maskFeather: 24,
        isCurrent: () => true
      }
    )).rejects.toThrow("group get failed");

    expect(harness.deleted).toEqual([50]);
    expect(harness.getActiveDocumentId()).toBe(20);
  });

  it("never deletes a pre-existing active layer when setup fails before placement", async () => {
    const harness = setupPartitionPlacement({ selectionReadFails: true });
    const plan = createGlobalPartitionPlan({
      width: 1000,
      height: 1000,
      overlap: 80,
      targetMaxEdge: 768
    });

    await expect(placePartitionedImages(
      10,
      [{ tile: plan.tiles[0], dataUrl: "data:image/png;base64,QQ==" }],
      {
        taskId: "partition",
        maskContract: 12,
        maskFeather: 24,
        isCurrent: () => true
      }
    )).rejects.toThrow("selection unavailable");

    expect(harness.deleted).toEqual([]);
  });
});
