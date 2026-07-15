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
  groupLayers,
  placeColorizedResult,
  prepareColorizeSource,
  restoreColorizeContext,
  validateColorizeSource
} from "./photoshop";

beforeEach(() => {
  vi.clearAllMocks();
});

const colorizeSource = {
  dataUrl: "data:image/png;base64,GRAY",
  documentId: 7,
  documentWidth: 1200,
  documentHeight: 800,
  selectionBounds: { left: 100, top: 80, right: 500, bottom: 380 },
  squareSize: 400
};

const colorizeUxp = () => ({
  storage: {
    formats: { binary: "binary" },
    localFileSystem: {
      getTemporaryFolder: vi.fn().mockResolvedValue({
        createFile: vi.fn().mockResolvedValue({ write: vi.fn().mockResolvedValue(undefined) })
      }),
      createSessionToken: vi.fn().mockResolvedValue("session-token")
    }
  }
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

describe("AI colorization Photoshop operations", () => {
  it("captures a centered square grayscale source in a temporary document", async () => {
    const originalDocument = {
      id: 7,
      width: 1200,
      height: 800,
      selection: { bounds: { left: 100, top: 80, right: 500, bottom: 380 } }
    };
    const temporaryDocument = { id: 99, width: 400, height: 300 };
    const app: any = { activeDocument: originalDocument };
    const createDocument = vi.fn().mockImplementation(async () => {
      app.activeDocument = temporaryDocument;
      return temporaryDocument;
    });
    const batchPlay = vi.fn().mockImplementation(async (descriptors) => {
      const descriptor = descriptors[0];
      if (descriptor?._obj === "get") {
        return [{ layerID: 51, bounds: { left: 0, top: 0, right: 400, bottom: 300 } }];
      }
      if (descriptor?._obj === "make" && descriptor?._target?.[0]?._ref === "adjustmentLayer") {
        return [{ layerID: 61 }];
      }
      if (descriptor?._obj === "select" && descriptor?._target?.[0]?._ref === "document") {
        app.activeDocument = originalDocument;
      }
      return [];
    });
    const encodeImageData = vi.fn()
      .mockResolvedValueOnce("SOURCE")
      .mockResolvedValueOnce("GRAY");
    boundary.bridge.uxp = {
      storage: {
        formats: { binary: "binary" },
        localFileSystem: {
          getTemporaryFolder: vi.fn().mockResolvedValue({
            createFile: vi.fn().mockResolvedValue({ write: vi.fn().mockResolvedValue(undefined) })
          }),
          createSessionToken: vi.fn().mockResolvedValue("session-token")
        }
      }
    };
    boundary.bridge.photoshop = {
      app: Object.assign(app, { createDocument, batchPlay }),
      imaging: {
        getPixels: vi.fn().mockResolvedValue({
          imageData: { dispose: vi.fn() }
        }),
        encodeImageData
      },
      core: { executeAsModal: vi.fn().mockImplementation(async (callback) => await callback()) }
    };

    await expect(prepareColorizeSource()).resolves.toEqual({
      dataUrl: "data:image/png;base64,GRAY",
      documentId: 7,
      documentWidth: 1200,
      documentHeight: 800,
      selectionBounds: { left: 100, top: 80, right: 500, bottom: 380 },
      squareSize: 400
    });
    expect(createDocument).toHaveBeenCalledWith(expect.objectContaining({ width: 400, height: 300 }));
    expect(batchPlay).toHaveBeenCalledWith([
      expect.objectContaining({
        _obj: "canvasSize",
        width: { _unit: "pixelsUnit", _value: 400 },
        height: { _unit: "pixelsUnit", _value: 400 }
      })
    ], {});
    expect(batchPlay).toHaveBeenCalledWith([
      expect.objectContaining({
        _obj: "make",
        using: expect.objectContaining({ type: { _obj: "blackAndWhite" } })
      })
    ], {});
    expect(encodeImageData).toHaveBeenCalledTimes(2);
    expect(app.activeDocument).toBe(originalDocument);
  });

  it("applies the square result in one history state and restores canvas and selection", async () => {
    const batchPlay = vi.fn().mockImplementation(async (descriptors) => {
      if (descriptors[0]?._obj === "get") {
        return [{
          layerID: 91,
          bounds: { left: 400, top: 400, right: 800, bottom: 800 }
        }];
      }
      return [];
    });
    const suspendHistory = vi.fn().mockResolvedValue("history-1");
    const resumeHistory = vi.fn().mockResolvedValue(undefined);
    const executeAsModal = vi.fn().mockImplementation(async (callback) => await callback({
      hostControl: { suspendHistory, resumeHistory }
    }));
    boundary.bridge.uxp = {
      storage: {
        formats: { binary: "binary" },
        localFileSystem: {
          getTemporaryFolder: vi.fn().mockResolvedValue({
            createFile: vi.fn().mockResolvedValue({ write: vi.fn().mockResolvedValue(undefined) })
          }),
          createSessionToken: vi.fn().mockResolvedValue("session-token")
        }
      }
    };
    boundary.bridge.photoshop = {
      app: {
        batchPlay,
        activeDocument: {
          id: 7,
          width: 1200,
          height: 800,
          selection: { bounds: { left: 100, top: 80, right: 500, bottom: 380 } }
        }
      },
      core: { executeAsModal }
    };
    const source = {
      dataUrl: "data:image/png;base64,GRAY",
      documentId: 7,
      documentWidth: 1200,
      documentHeight: 800,
      selectionBounds: { left: 100, top: 80, right: 500, bottom: 380 },
      squareSize: 400
    };

    await expect(placeColorizedResult(
      source,
      "data:image/png;base64,Q09MT1I=",
      () => true
    )).resolves.toEqual({ layerId: 91 });

    expect(suspendHistory).toHaveBeenCalledWith({ documentID: 7, name: "AI 智能调色" });
    expect(resumeHistory).toHaveBeenCalledWith("history-1");
    const descriptors = batchPlay.mock.calls.flatMap(([items]) => items);
    expect(descriptors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        _obj: "canvasSize",
        width: { _unit: "pixelsUnit", _value: 1200 },
        height: { _unit: "pixelsUnit", _value: 1200 }
      }),
      expect.objectContaining({
        _obj: "set",
        _target: [{ _ref: "layer", _id: 91 }],
        to: expect.objectContaining({ mode: { _enum: "blendMode", _value: "color" } })
      }),
      expect.objectContaining({
        _obj: "canvasSize",
        width: { _unit: "pixelsUnit", _value: 1200 },
        height: { _unit: "pixelsUnit", _value: 800 }
      })
    ]));
    const selectionRestores = descriptors.filter((descriptor) =>
      descriptor._obj === "set" && descriptor._target?.[0]?._property === "selection"
    );
    expect(selectionRestores[selectionRestores.length - 1]?.to).toEqual(expect.objectContaining({
      left: { _unit: "pixelsUnit", _value: 100 },
      top: { _unit: "pixelsUnit", _value: 80 }
    }));
  });

  it("deletes a landed layer when the post-place lookup fails", async () => {
    const batchPlay = vi.fn().mockImplementation(async (descriptors) => {
      if (descriptors[0]?._obj === "placeEvent") return [{ layerID: 92 }];
      if (descriptors[0]?._obj === "get") throw new Error("lookup failed");
      return [];
    });
    const resumeHistory = vi.fn().mockResolvedValue(undefined);
    const activeDocument = {
      id: 7,
      width: 1200,
      height: 800,
      selection: { bounds: { left: 100, top: 80, right: 500, bottom: 380 } }
    };
    boundary.bridge.uxp = colorizeUxp();
    boundary.bridge.photoshop = {
      app: { batchPlay, activeDocument },
      core: {
        executeAsModal: vi.fn().mockImplementation(async (callback) => await callback({
          hostControl: {
            suspendHistory: vi.fn().mockResolvedValue("history-1"),
            resumeHistory
          }
        }))
      }
    };

    await expect(placeColorizedResult(colorizeSource, "data:image/png;base64,Q09MT1I=", () => true))
      .rejects.toThrow("lookup failed");

    expect(resumeHistory).toHaveBeenCalledWith("history-1");
    expect(batchPlay).toHaveBeenCalledWith([{
      _obj: "delete",
      _target: [{ _ref: "layer", _id: 92 }]
    }], {});
  });

  it("cleans up the output layer when history resumption fails", async () => {
    const batchPlay = vi.fn().mockImplementation(async (descriptors) => {
      if (descriptors[0]?._obj === "placeEvent") return [{ layerID: 93 }];
      if (descriptors[0]?._obj === "get") {
        return [{ layerID: 93, bounds: { left: 400, top: 400, right: 800, bottom: 800 } }];
      }
      return [];
    });
    const activeDocument = {
      id: 7,
      width: 1200,
      height: 800,
      selection: { bounds: { left: 100, top: 80, right: 500, bottom: 380 } }
    };
    boundary.bridge.uxp = colorizeUxp();
    boundary.bridge.photoshop = {
      app: { batchPlay, activeDocument },
      core: {
        executeAsModal: vi.fn().mockImplementation(async (callback) => await callback({
          hostControl: {
            suspendHistory: vi.fn().mockResolvedValue("history-1"),
            resumeHistory: vi.fn().mockRejectedValue(new Error("resume failed"))
          }
        }))
      }
    };

    await expect(placeColorizedResult(colorizeSource, "data:image/png;base64,Q09MT1I=", () => true))
      .rejects.toThrow("resume failed");

    expect(batchPlay).toHaveBeenCalledWith([{
      _obj: "delete",
      _target: [{ _ref: "layer", _id: 93 }]
    }], {});
  });

  it("rolls back cancellation after placement inside the suspended history operation", async () => {
    const batchPlay = vi.fn().mockImplementation(async (descriptors) => {
      if (descriptors[0]?._obj === "placeEvent") return [{ layerID: 94 }];
      if (descriptors[0]?._obj === "get") {
        return [{ layerID: 94, bounds: { left: 400, top: 400, right: 800, bottom: 800 } }];
      }
      return [];
    });
    const isCurrent = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    const suspendHistory = vi.fn().mockResolvedValue("history-1");
    const resumeHistory = vi.fn().mockResolvedValue(undefined);
    const executeAsModal = vi.fn().mockImplementation(async (callback) => await callback({
      hostControl: { suspendHistory, resumeHistory }
    }));
    boundary.bridge.uxp = colorizeUxp();
    boundary.bridge.photoshop = {
      app: {
        batchPlay,
        activeDocument: {
          id: 7,
          width: 1200,
          height: 800,
          selection: { bounds: { left: 100, top: 80, right: 500, bottom: 380 } }
        }
      },
      core: { executeAsModal }
    };

    await expect(placeColorizedResult(colorizeSource, "data:image/png;base64,Q09MT1I=", isCurrent))
      .rejects.toThrow("COLORIZE_CANCELLED");

    expect(executeAsModal).toHaveBeenCalledOnce();
    expect(suspendHistory).toHaveBeenCalledOnce();
    expect(resumeHistory).toHaveBeenCalledOnce();
    expect(batchPlay).toHaveBeenCalledWith([{
      _obj: "delete",
      _target: [{ _ref: "layer", _id: 94 }]
    }], {});
  });

  it("does not rewrite selection when the colorize context already matches", async () => {
    const batchPlay = vi.fn();
    boundary.bridge.photoshop = {
      app: {
        batchPlay,
        activeDocument: {
          id: 7,
          selection: { bounds: { left: 100, top: 80, right: 500, bottom: 380 } }
        }
      },
      core: { executeAsModal: vi.fn().mockImplementation(async (callback) => await callback()) }
    };

    await restoreColorizeContext(colorizeSource);

    expect(batchPlay).not.toHaveBeenCalled();
  });

  it("captures and restores the whole canvas when there is no selection", async () => {
    const originalDocument = { id: 7, width: 300, height: 200 };
    const temporaryDocument = { id: 99, width: 300, height: 200 };
    const app: any = { activeDocument: originalDocument };
    const createDocument = vi.fn().mockImplementation(async () => {
      app.activeDocument = temporaryDocument;
      return temporaryDocument;
    });
    const batchPlay = vi.fn().mockImplementation(async (descriptors) => {
      const descriptor = descriptors[0];
      if (descriptor?._obj === "get") {
        return [{ layerID: 51, bounds: { left: 0, top: 0, right: 300, bottom: 200 } }];
      }
      if (descriptor?._obj === "make" && descriptor?._target?.[0]?._ref === "adjustmentLayer") {
        return [{ layerID: 61 }];
      }
      if (descriptor?._obj === "select" && descriptor?._target?.[0]?._ref === "document") {
        app.activeDocument = originalDocument;
      }
      return [];
    });
    const encodeImageData = vi.fn()
      .mockResolvedValueOnce("FULL")
      .mockResolvedValueOnce("GRAY");
    boundary.bridge.uxp = colorizeUxp();
    boundary.bridge.photoshop = {
      app: Object.assign(app, { createDocument, batchPlay }),
      imaging: {
        getPixels: vi.fn().mockResolvedValue({ imageData: { dispose: vi.fn() } }),
        encodeImageData
      },
      core: { executeAsModal: vi.fn().mockImplementation(async (callback) => await callback()) }
    };

    await expect(prepareColorizeSource()).resolves.toMatchObject({
      dataUrl: "data:image/png;base64,GRAY",
      documentId: 7,
      documentWidth: 300,
      documentHeight: 200,
      selectionBounds: null,
      squareSize: 300
    });
    expect(createDocument).toHaveBeenCalledWith(expect.objectContaining({ width: 300, height: 200 }));
    expect(boundary.bridge.photoshop.imaging.getPixels).toHaveBeenNthCalledWith(1, expect.objectContaining({
      documentID: 7,
      sourceBounds: { left: 0, top: 0, right: 300, bottom: 200 }
    }));
  });

  it("places whole-canvas colorization and restores an empty selection", async () => {
    const batchPlay = vi.fn().mockImplementation(async (descriptors) => {
      if (descriptors[0]?._obj === "get") {
        return [{ layerID: 96, bounds: { left: 0, top: 0, right: 300, bottom: 300 } }];
      }
      return [];
    });
    boundary.bridge.uxp = colorizeUxp();
    boundary.bridge.photoshop = {
      app: { batchPlay, activeDocument: { id: 7, width: 300, height: 200 } },
      core: {
        executeAsModal: vi.fn().mockImplementation(async (callback) => await callback({
          hostControl: {
            suspendHistory: vi.fn().mockResolvedValue("history-1"),
            resumeHistory: vi.fn().mockResolvedValue(undefined)
          }
        }))
      }
    };
    const source = {
      ...colorizeSource,
      documentWidth: 300,
      documentHeight: 200,
      selectionBounds: null,
      squareSize: 300
    };

    await expect(placeColorizedResult(source, "data:image/png;base64,Q09MT1I=", () => true))
      .resolves.toEqual({ layerId: 96 });

    const descriptors = batchPlay.mock.calls.flatMap(([items]) => items);
    const selectionRestores = descriptors.filter((descriptor) =>
      descriptor._obj === "set" && descriptor._target?.[0]?._property === "selection"
    );
    expect(selectionRestores[selectionRestores.length - 1]?.to).toEqual({
      _enum: "ordinal",
      _value: "none"
    });
  });

  it("rejects resized source documents before making Photoshop changes", async () => {
    const batchPlay = vi.fn();
    boundary.bridge.photoshop = {
      app: { batchPlay, activeDocument: { id: 7, width: 1000, height: 800 } },
      core: { executeAsModal: vi.fn() }
    };

    await expect(validateColorizeSource(colorizeSource)).rejects.toThrow("画布尺寸已变化");
    expect(batchPlay).not.toHaveBeenCalled();
    expect(boundary.bridge.photoshop.core.executeAsModal).not.toHaveBeenCalled();
  });

  it("deletes a color layer that commits after the caller times out", async () => {
    let finishResume: (() => void) | undefined;
    const resumeHistory = vi.fn().mockImplementation(() => new Promise<void>((resolve) => {
      finishResume = resolve;
    }));
    const batchPlay = vi.fn().mockImplementation(async (descriptors) => {
      if (descriptors[0]?._obj === "placeEvent") return [{ layerID: 97 }];
      if (descriptors[0]?._obj === "get") {
        return [{ layerID: 97, bounds: { left: 400, top: 400, right: 800, bottom: 800 } }];
      }
      return [];
    });
    boundary.bridge.uxp = colorizeUxp();
    boundary.bridge.photoshop = {
      app: {
        batchPlay,
        activeDocument: {
          id: 7,
          width: 1200,
          height: 800,
          selection: { bounds: { left: 100, top: 80, right: 500, bottom: 380 } }
        }
      },
      core: {
        executeAsModal: vi.fn().mockImplementation(async (callback) => await callback({
          hostControl: {
            suspendHistory: vi.fn().mockResolvedValue("history-1"),
            resumeHistory
          }
        }))
      }
    };

    const placement = placeColorizedResult(
      colorizeSource,
      "data:image/png;base64,Q09MT1I=",
      () => true,
      { taskId: "late-colorize", timeoutMs: 20 }
    );
    await expect(placement).rejects.toThrow("timed out");
    await expect(validateColorizeSource(colorizeSource, { taskId: "blocked-after-timeout" }))
      .rejects.toThrow("circuit is open");

    finishResume?.();
    await vi.waitFor(() => expect(batchPlay).toHaveBeenCalledWith([{
      _obj: "delete",
      _target: [{ _ref: "layer", _id: 97 }]
    }], {}));
    await new Promise((resolve) => setTimeout(resolve, 200));
    await expect(validateColorizeSource(colorizeSource, { taskId: "after-late-cleanup" }))
      .resolves.toBeUndefined();
  });
});
