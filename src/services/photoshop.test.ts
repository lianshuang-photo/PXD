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

  it("captures a feather-preserving transparent subject reference through the saved alpha channel", async () => {
    const disposes = [vi.fn(), vi.fn()];
    const getPixels = vi.fn()
      .mockResolvedValueOnce({ imageData: { dispose: disposes[0] } })
      .mockResolvedValueOnce({ imageData: { dispose: disposes[1] } });
    const encodeImageData = vi.fn()
      .mockResolvedValueOnce("QUJD")
      .mockResolvedValueOnce("REVG");
    const runner = { write: vi.fn() };
    boundary.bridge.getDataFolder.mockResolvedValue({ createFile: vi.fn().mockResolvedValue(runner) });
    boundary.bridge.createSessionToken.mockResolvedValue("jsx-token");
    const activeDocument: any = {
      id: 10,
      width: { value: 2000 },
      height: { value: 1000 },
      selection: { bounds: { left: 100, top: 100, right: 700, bottom: 900 } },
      activeLayer: { id: 11 }
    };
    let jsxCalls = 0;
    const batchPlay = vi.fn().mockImplementation(async (descriptors: any[]) => {
      if (descriptors[0]?._obj === "AdobeScriptAutomation Scripts") {
        jsxCalls += 1;
        if (jsxCalls === 2) activeDocument.activeLayer = { id: 77 };
      }
      return [{}];
    });
    boundary.bridge.photoshop = {
      app: { activeDocument, batchPlay },
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
      layerID: 77,
      sourceBounds: { left: 100, top: 100, right: 700, bottom: 900 },
      targetSize: { width: 600, height: 800 },
      applyAlpha: true
    }));
    expect(disposes[0]).toHaveBeenCalledOnce();
    expect(disposes[1]).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      baseImageDataUrl: "data:image/png;base64,QUJD",
      referenceImageDataUrl: "data:image/png;base64,REVG",
      selectionChannelName: expect.stringContaining("__PXD_SCENE_10_")
    });
    expect(runner.write.mock.calls.some(([jsx]) =>
      String(jsx).includes("doc.selection.copy(true)") && String(jsx).includes("doc.selection.load(channel")
    )).toBe(true);
    expect(batchPlay).toHaveBeenCalledWith([{
      _obj: "delete",
      _target: [{ _ref: "layer", _id: 77 }]
    }], { synchronousExecution: true });
  });

  const setupPlacement = (flags: {
    failTransform?: boolean;
    failDelete?: boolean;
    failLookup?: boolean;
    failResume?: boolean;
    regularLayer?: boolean;
    silentNoop?: boolean;
  } = {}) => {
    const deleted: number[] = [];
    const maskModes: string[] = [];
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
    const activeDocument: any = { id: 10, activeLayer: { id: 11 } };
    let targetGetCount = 0;
    let idGetCount = 0;
    const batchPlay = vi.fn().mockImplementation(async (descriptors: any[]) => {
      const descriptor = descriptors[0];
      if (descriptor?._obj === "placeEvent") {
        if (flags.silentNoop) return [];
        activeDocument.activeLayer = { id: 42 };
        return [{ layerID: 42 }];
      }
      if (descriptor?._obj === "transform") {
        if (flags.failTransform) throw new Error("transform failed");
        return [];
      }
      if (descriptor?._obj === "get" && descriptor._target?.[0]?._id === 42) {
        idGetCount += 1;
        return [{
          layerID: 42,
          hasUserMask: idGetCount > 1,
          bounds: {
            left: { _value: 0 }, top: { _value: 0 },
            right: { _value: 2000 }, bottom: { _value: 1000 }
          }
        }];
      }
      if (descriptor?._obj === "get") {
        targetGetCount += 1;
        if (targetGetCount === 1) return [{ layerID: 11, layerKind: 1 }];
        if (flags.failLookup) throw new Error("lookup failed");
        if (flags.silentNoop) return [{ layerID: 11, layerKind: 1 }];
        return [{
          layerID: 42,
          ...(flags.regularLayer ? { layerKind: 1 } : { smartObject: { linked: false } }),
          bounds: {
            left: { _value: 0 }, top: { _value: 0 },
            right: { _value: 1000 }, bottom: { _value: 1000 }
          }
        }];
      }
      for (const item of descriptors) {
        if (item?._obj === "make") maskModes.push(item.using?._value);
      }
      if (descriptor?._obj === "delete" && descriptor._target?.[0]?._ref === "layer") {
        if (flags.failDelete) throw new Error("delete failed");
        deleted.push(descriptor._target[0]._id);
      }
      return [{}];
    });
    const suspendHistory = vi.fn().mockResolvedValue("scene-history");
    const resumeHistory = flags.failResume
      ? vi.fn().mockRejectedValue(new Error("resume failed"))
      : vi.fn().mockResolvedValue(undefined);
    boundary.bridge.photoshop = {
      app: { batchPlay, activeDocument },
      core: { executeAsModal: vi.fn().mockImplementation(async (callback) => await callback({
        hostControl: { suspendHistory, resumeHistory }
      })) }
    };
    return { activeDocument, batchPlay, deleted, maskModes, resumeHistory, suspendHistory };
  };

  it("strictly fills the canvas and hides the generated layer inside the stored subject selection", async () => {
    const harness = setupPlacement();
    const source = { ...capture };
    const result = await placeSceneBackground(source, "data:image/png;base64,T1VU", {
      protectSubject: true,
      layerName: "PXD Scene",
      isCurrent: () => true
    });
    expect(result).toEqual({ layerId: 42 });
    expect(harness.maskModes).toContain("hideSelection");
    expect(harness.deleted).toEqual([]);
    expect(harness.suspendHistory).toHaveBeenCalledWith({ documentID: 10, name: "PXD Scene" });
    expect(harness.resumeHistory).toHaveBeenCalledWith("scene-history");
    expect(source.selectionChannelName).toBeNull();
  });

  it("deletes the known landed layer when strict transform fails", async () => {
    const harness = setupPlacement({ failTransform: true });
    await expect(placeSceneBackground(capture, "data:image/png;base64,T1VU", {
      protectSubject: false,
      layerName: "PXD Scene",
      isCurrent: () => true
    })).rejects.toThrow("transform failed");
    expect(harness.deleted).toEqual([42]);
  });

  it("marks a failed landed-layer rollback as a recovery failure", async () => {
    setupPlacement({ failTransform: true, failDelete: true });
    await expect(placeSceneBackground(capture, "data:image/png;base64,T1VU", {
      protectSubject: false,
      layerName: "PXD Scene",
      isCurrent: () => true
    })).rejects.toMatchObject({
      name: "ScenePlacementPartialError",
      recoveryFailed: true
    });
  });

  it("never deletes the user's active layer when place is a silent no-op", async () => {
    const harness = setupPlacement({ silentNoop: true });
    await expect(placeSceneBackground({ ...capture, selectionChannelName: null }, "data:image/png;base64,T1VU", {
      protectSubject: false,
      layerName: "PXD Scene",
      isCurrent: () => true
    })).rejects.toThrow("未创建新的场景背景图层");
    expect(harness.deleted).toEqual([]);
    expect(harness.activeDocument.activeLayer.id).toBe(11);
  });

  it("returns a structured partial and deletes the exact placed layer when lookup fails", async () => {
    const harness = setupPlacement({ failLookup: true });
    await expect(placeSceneBackground({ ...capture, selectionChannelName: null }, "data:image/png;base64,T1VU", {
      protectSubject: false,
      layerName: "PXD Scene",
      isCurrent: () => true
    })).rejects.toMatchObject({
      name: "ScenePlacementPartialError",
      layerId: 42,
      cleanupComplete: true,
      recoveryFailed: false
    });
    expect(harness.deleted).toEqual([42]);
  });

  it("rejects and removes a newly placed regular layer", async () => {
    const harness = setupPlacement({ regularLayer: true });
    await expect(placeSceneBackground({ ...capture, selectionChannelName: null }, "data:image/png;base64,T1VU", {
      protectSubject: false,
      layerName: "PXD Scene",
      isCurrent: () => true
    })).rejects.toThrow("不是新的智能对象");
    expect(harness.deleted).toEqual([42]);
  });

  it("compensates the exact layer and flags an unresolved history suspension", async () => {
    const harness = setupPlacement({ failResume: true });
    await expect(placeSceneBackground({ ...capture, selectionChannelName: null }, "data:image/png;base64,T1VU", {
      protectSubject: false,
      layerName: "PXD Scene",
      isCurrent: () => true
    })).rejects.toMatchObject({
      name: "ScenePlacementPartialError",
      layerId: 42,
      cleanupComplete: true,
      recoveryFailed: true
    });
    expect(harness.deleted).toEqual([42]);
    expect(harness.resumeHistory).toHaveBeenCalledTimes(2);
  });

  it("keeps settlement pending after timeout and deletes the exact late layer", async () => {
    const harness = setupPlacement();
    let releaseModal!: () => void;
    const modalGate = new Promise<void>((resolve) => { releaseModal = resolve; });
    boundary.bridge.photoshop.core.executeAsModal.mockImplementation(async (callback: any, modalOptions: any) => {
      const result = await callback({
        hostControl: { suspendHistory: harness.suspendHistory, resumeHistory: harness.resumeHistory }
      });
      if (modalOptions?.commandName === "回贴 PXD 场景背景") await modalGate;
      return result;
    });
    let settled = false;
    const placement = placeSceneBackground(
      { ...capture, selectionChannelName: null },
      "data:image/png;base64,T1VU",
      {
        protectSubject: false,
        layerName: "PXD Scene",
        isCurrent: () => true,
        taskId: "late-scene-layer",
        timeoutMs: 20
      }
    ).catch((error) => error).then((result) => {
      settled = true;
      return result;
    });
    await vi.waitFor(() => expect(harness.batchPlay.mock.calls.some(
      ([items]) => items[0]?._obj === "placeEvent"
    )).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(settled).toBe(false);
    releaseModal();
    await expect(placement).resolves.toMatchObject({ name: "PSOperationTimeoutError" });
    expect(harness.deleted).toEqual([42]);
  });

  it("keeps the circuit blocked when late exact-layer cleanup fails", async () => {
    const harness = setupPlacement({ failDelete: true });
    let releaseModal!: () => void;
    const modalGate = new Promise<void>((resolve) => { releaseModal = resolve; });
    boundary.bridge.photoshop.core.executeAsModal.mockImplementation(async (callback: any, modalOptions: any) => {
      const result = await callback({
        hostControl: { suspendHistory: harness.suspendHistory, resumeHistory: harness.resumeHistory }
      });
      if (modalOptions?.commandName === "回贴 PXD 场景背景") await modalGate;
      return result;
    });
    const placement = placeSceneBackground(
      { ...capture, selectionChannelName: null },
      "data:image/png;base64,T1VU",
      {
        protectSubject: false,
        layerName: "PXD Scene",
        isCurrent: () => true,
        taskId: "late-scene-cleanup-failure",
        timeoutMs: 20
      }
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    releaseModal();
    await expect(placement).rejects.toMatchObject({
      name: "ScenePlacementPartialError",
      layerId: 42,
      cleanupComplete: false,
      recoveryFailed: true
    });
  });
});
