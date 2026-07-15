import { beforeEach, describe, expect, it, vi } from "vitest";

const photoshop = vi.hoisted(() => ({
  captureRelightSource: vi.fn(),
  validateRelightSource: vi.fn(),
  placeRelitResult: vi.fn(),
  rollbackRelitResult: vi.fn(),
  restoreRelightContext: vi.fn()
}));

vi.mock("./photoshop", () => photoshop);

import { RELIGHT_PHOTOSHOP_ADAPTER } from "./relightPhotoshopAdapter";

const source = {
  dataUrl: "data:image/png;base64,aA==",
  documentId: 4,
  documentWidth: 20,
  documentHeight: 10,
  selectionBounds: null
};

describe("RELIGHT_PHOTOSHOP_ADAPTER", () => {
  beforeEach(() => vi.clearAllMocks());

  it("scopes every Photoshop operation to the workflow task", async () => {
    photoshop.captureRelightSource.mockResolvedValue(source);
    photoshop.placeRelitResult.mockResolvedValue({ layerId: 8 });
    await RELIGHT_PHOTOSHOP_ADAPTER.capture("task-a");
    await RELIGHT_PHOTOSHOP_ADAPTER.validate(source, "task-a");
    const current = () => true;
    await RELIGHT_PHOTOSHOP_ADAPTER.apply(source, "data:image/png;base64,eA==", "task-a", current);
    await RELIGHT_PHOTOSHOP_ADAPTER.rollback(source, 8, "task-a");
    await RELIGHT_PHOTOSHOP_ADAPTER.restore(source, "task-a");
    expect(photoshop.captureRelightSource).toHaveBeenCalledWith({ taskId: "task-a" });
    expect(photoshop.validateRelightSource).toHaveBeenCalledWith(source, { taskId: "task-a" });
    expect(photoshop.placeRelitResult).toHaveBeenCalledWith(source, expect.any(String), current, { taskId: "task-a" });
    expect(photoshop.rollbackRelitResult).toHaveBeenCalledWith(source, 8, { taskId: "task-a" });
    expect(photoshop.restoreRelightContext).toHaveBeenCalledWith(source, { taskId: "task-a" });
  });
});
