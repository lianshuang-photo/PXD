import { beforeEach, describe, expect, it, vi } from "vitest";

const photoshop = vi.hoisted(() => ({
  captureVfxSource: vi.fn(),
  discardVfxSource: vi.fn(),
  validateVfxSource: vi.fn(),
  placeVfxResult: vi.fn(),
  rollbackVfxResult: vi.fn(),
  restoreVfxContext: vi.fn()
}));

vi.mock("./photoshop", () => photoshop);

import { DEFAULT_VFX_CONFIG } from "./vfx";
import { VFX_PHOTOSHOP_ADAPTER } from "./vfxPhotoshopAdapter";

const source = {
  dataUrl: "data:image/png;base64,aA==",
  documentId: 4,
  documentWidth: 20,
  documentHeight: 10,
  selectionBounds: null,
  selectionChannelName: null
};

describe("VFX_PHOTOSHOP_ADAPTER", () => {
  beforeEach(() => vi.clearAllMocks());

  it("scopes every operation and forwards blend/mask placement", async () => {
    photoshop.captureVfxSource.mockResolvedValue(source);
    photoshop.placeVfxResult.mockResolvedValue({ layerId: 8 });
    await VFX_PHOTOSHOP_ADAPTER.capture("task-a");
    await VFX_PHOTOSHOP_ADAPTER.validate(source, "task-a");
    const current = () => true;
    await VFX_PHOTOSHOP_ADAPTER.apply(source, "data:image/png;base64,eA==", DEFAULT_VFX_CONFIG, "task-a", current);
    await VFX_PHOTOSHOP_ADAPTER.rollback(source, 8, "task-a");
    await VFX_PHOTOSHOP_ADAPTER.restore(source, "task-a");
    await VFX_PHOTOSHOP_ADAPTER.discard(source, "task-a");
    expect(photoshop.captureVfxSource).toHaveBeenCalledWith({ taskId: "task-a" });
    expect(photoshop.validateVfxSource).toHaveBeenCalledWith(source, { taskId: "task-a" });
    expect(photoshop.placeVfxResult).toHaveBeenCalledWith(
      source,
      expect.any(String),
      { blendMode: "screen", useSelectionMask: true },
      current,
      { taskId: "task-a" }
    );
    expect(photoshop.rollbackVfxResult).toHaveBeenCalledWith(source, 8, { taskId: "task-a" });
    expect(photoshop.restoreVfxContext).toHaveBeenCalledWith(source, { taskId: "task-a" });
    expect(photoshop.discardVfxSource).toHaveBeenCalledWith(source, { taskId: "task-a" });
  });
});
