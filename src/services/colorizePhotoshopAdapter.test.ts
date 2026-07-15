import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ColorizeSource } from "./photoshop";

const boundary = vi.hoisted(() => ({
  deleteLayer: vi.fn(),
  placeColorizedResult: vi.fn(),
  prepareColorizeSource: vi.fn(),
  restoreColorizeContext: vi.fn()
}));

vi.mock("./photoshop", () => boundary);

import { COLORIZE_PHOTOSHOP_ADAPTER } from "./colorizePhotoshopAdapter";

const source = { documentId: 7 } as ColorizeSource;

beforeEach(() => {
  vi.clearAllMocks();
  boundary.prepareColorizeSource.mockResolvedValue(source);
  boundary.placeColorizedResult.mockResolvedValue({ layerId: 41 });
  boundary.restoreColorizeContext.mockResolvedValue(undefined);
  boundary.deleteLayer.mockResolvedValue(undefined);
});

describe("COLORIZE_PHOTOSHOP_ADAPTER", () => {
  it("scopes every Photoshop operation to the colorize task", async () => {
    const isCurrent = vi.fn().mockReturnValue(true);

    await expect(COLORIZE_PHOTOSHOP_ADAPTER.prepare("task-1")).resolves.toBe(source);
    await expect(COLORIZE_PHOTOSHOP_ADAPTER.apply(source, "data:image/png;base64,X", "task-1", isCurrent))
      .resolves.toEqual({ layerId: 41 });
    await COLORIZE_PHOTOSHOP_ADAPTER.rollback(source, 41, "task-1");
    await COLORIZE_PHOTOSHOP_ADAPTER.restore(source, "task-1");

    expect(boundary.prepareColorizeSource).toHaveBeenCalledWith({ taskId: "task-1" });
    expect(boundary.placeColorizedResult).toHaveBeenCalledWith(
      source,
      "data:image/png;base64,X",
      isCurrent,
      { taskId: "task-1" }
    );
    expect(boundary.restoreColorizeContext).toHaveBeenNthCalledWith(1, source, { taskId: "task-1" });
    expect(boundary.deleteLayer).toHaveBeenCalledWith(41, { taskId: "task-1" });
  });

  it("still attempts layer deletion when context restoration fails", async () => {
    boundary.restoreColorizeContext.mockRejectedValue(new Error("restore failed"));

    await expect(COLORIZE_PHOTOSHOP_ADAPTER.rollback(source, 41, "task-1"))
      .rejects.toThrow("restore failed");

    expect(boundary.deleteLayer).toHaveBeenCalledWith(41, { taskId: "task-1" });
  });

  it("combines context and layer cleanup failures", async () => {
    boundary.restoreColorizeContext.mockRejectedValue(new Error("restore failed"));
    boundary.deleteLayer.mockRejectedValue(new Error("delete failed"));

    await expect(COLORIZE_PHOTOSHOP_ADAPTER.rollback(source, 41, "task-1"))
      .rejects.toThrow("restore failed；图层删除失败：delete failed");
  });
});
