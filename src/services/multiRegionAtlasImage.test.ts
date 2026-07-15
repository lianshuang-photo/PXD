import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMultiRegionAtlasPlan, type AtlasRegionCapture } from "./multiRegionAtlas";
import {
  composeMultiRegionAtlas,
  normalizeMultiRegionAtlasResult,
  splitMultiRegionAtlas
} from "./multiRegionAtlasImage";

const regions: AtlasRegionCapture[] = [
  {
    id: "one",
    documentId: 7,
    bounds: { left: 10, top: 20, right: 410, bottom: 320 },
    sourceWidth: 400,
    sourceHeight: 300,
    imageWidth: 400,
    imageHeight: 300,
    dataUrl: "data:image/png;base64,QQ==",
    encodedBytes: 1
  },
  {
    id: "two",
    documentId: 7,
    bounds: { left: 500, top: 60, right: 700, bottom: 560 },
    sourceWidth: 200,
    sourceHeight: 500,
    imageWidth: 200,
    imageHeight: 500,
    dataUrl: "data:image/png;base64,Qg==",
    encodedBytes: 1
  }
];

describe("multi-region atlas image processing", () => {
  const drawImage = vi.fn();
  const fillRect = vi.fn();
  const clearRect = vi.fn();
  const canvases: Array<{ width: number; height: number }> = [];
  let imageSizes = [{ width: 400, height: 300 }, { width: 200, height: 500 }];
  let imageIndex = 0;

  beforeEach(() => {
    vi.clearAllMocks();
    canvases.length = 0;
    imageIndex = 0;
    imageSizes = [{ width: 400, height: 300 }, { width: 200, height: 500 }];
    class FakeImage {
      naturalWidth = imageSizes[imageIndex]?.width ?? imageSizes[imageSizes.length - 1]?.width ?? 1;
      naturalHeight = imageSizes[imageIndex]?.height ?? imageSizes[imageSizes.length - 1]?.height ?? 1;
      width = this.naturalWidth;
      height = this.naturalHeight;
      onload: null | (() => void) = null;
      onerror: null | (() => void) = null;
      set src(_value: string) {
        imageIndex += 1;
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal("Image", FakeImage);
    vi.stubGlobal("document", {
      createElement: vi.fn().mockImplementation(() => {
        const canvas = {
          width: 0,
          height: 0,
          getContext: vi.fn().mockReturnValue({ drawImage, fillRect, clearRect, fillStyle: "" }),
          toDataURL: vi.fn().mockReturnValue("data:image/png;base64,QQ==")
        };
        canvases.push(canvas);
        return canvas;
      })
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("draws only inside content bounds and keeps frames outside the split ledger", async () => {
    const plan = createMultiRegionAtlasPlan({ regions, targetMaxEdge: 1024 });
    const atlas = await composeMultiRegionAtlas(regions, plan, () => true);
    expect(atlas).toMatchObject({ width: plan.width, height: plan.height, base64: "QQ==" });
    expect(fillRect).toHaveBeenCalledTimes(1 + regions.length);
    for (let index = 0; index < plan.items.length; index += 1) {
      const bounds = plan.items[index].contentBounds;
      expect(drawImage).toHaveBeenNthCalledWith(
        index + 1,
        expect.anything(),
        bounds.left,
        bounds.top,
        bounds.right - bounds.left,
        bounds.bottom - bounds.top
      );
    }
  });

  it("normalizes a same-ratio model result then splits exact content rectangles", async () => {
    const plan = createMultiRegionAtlasPlan({ regions, targetMaxEdge: 1024 });
    imageSizes = [
      { width: plan.width * 2, height: plan.height * 2 },
      { width: plan.width, height: plan.height }
    ];
    const normalized = await normalizeMultiRegionAtlasResult("QQ==", plan, { isCurrent: () => true });
    expect(normalized).toMatchObject({ width: plan.width, height: plan.height });
    const parts = await splitMultiRegionAtlas(normalized, plan, { isCurrent: () => true });
    expect(parts.map((part) => part.regionId)).toEqual(["one", "two"]);
    for (let index = 0; index < parts.length; index += 1) {
      const bounds = plan.items[index].contentBounds;
      expect(parts[index]).toMatchObject({
        width: bounds.right - bounds.left,
        height: bounds.bottom - bounds.top
      });
    }
  });

  it("rejects a changed result aspect ratio before splitting", async () => {
    const plan = createMultiRegionAtlasPlan({ regions, targetMaxEdge: 1024 });
    imageSizes = [{ width: plan.width, height: Math.max(1, Math.floor(plan.height / 2)) }];
    await expect(normalizeMultiRegionAtlasResult("QQ==", plan)).rejects.toThrow("宽高比");
  });

  it("includes a retained input atlas in the 96 MiB peak-memory check", async () => {
    const plan = createMultiRegionAtlasPlan({ regions, targetMaxEdge: 1024 });
    await expect(normalizeMultiRegionAtlasResult("QQ==", plan, {
      maxWorkingBytes: 1024 * 1024,
      retainedBytes: 1024 * 1024
    })).rejects.toThrow("实际字节数");
  });
});
