import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { featherTileDataUrl } from "./tileImage";

describe("featherTileDataUrl", () => {
  const alpha = new Uint8ClampedArray([255, 255, 255, 255, 255, 255, 255, 255]);
  const putImageData = vi.fn();
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn().mockReturnValue({
      drawImage: vi.fn(),
      getImageData: vi.fn().mockReturnValue({ data: alpha }),
      putImageData
    }),
    toDataURL: vi.fn().mockReturnValue("data:image/png;base64,BLENDED")
  };

  beforeEach(() => {
    alpha[3] = 255;
    alpha[7] = 255;
    vi.clearAllMocks();
    class FakeImage {
      naturalWidth = 2;
      naturalHeight = 1;
      width = 2;
      height = 1;
      onload: null | (() => void) = null;
      onerror: null | (() => void) = null;
      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal("Image", FakeImage);
    vi.stubGlobal("document", { createElement: vi.fn().mockReturnValue(canvas) });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("applies a raised-cosine alpha only to incoming edges", async () => {
    await expect(featherTileDataUrl("data:image/png;base64,TILE", {
      left: 2,
      top: 0,
      outputWidth: 2,
      outputHeight: 1,
      isCurrent: () => true
    })).resolves.toBe("data:image/png;base64,BLENDED");

    expect(alpha[3]).toBe(0);
    expect(alpha[7]).toBe(127);
    expect(putImageData).toHaveBeenCalledOnce();
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
  });

  it("yields to cancellation and releases its canvas", async () => {
    await expect(featherTileDataUrl("data:image/png;base64,TILE", {
      left: 0,
      top: 0,
      outputWidth: 2,
      outputHeight: 1,
      isCurrent: () => false
    })).rejects.toThrow("已取消");
    expect(putImageData).not.toHaveBeenCalled();
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
  });
});
