import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodedBase64Bytes, normalizeGlobalPartitionImage } from "./globalPartitionImage";

describe("global partition image budgeting", () => {
  let imageWidth = 2048;
  let imageHeight = 1024;
  const drawImage = vi.fn();
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn().mockReturnValue({ drawImage }),
    toDataURL: vi.fn().mockReturnValue("data:image/png;base64,QUJDRA==")
  };

  beforeEach(() => {
    vi.clearAllMocks();
    imageWidth = 2048;
    imageHeight = 1024;
    class FakeImage {
      width = imageWidth;
      height = imageHeight;
      naturalWidth = imageWidth;
      naturalHeight = imageHeight;
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

  it("counts actual encoded bytes and downsamples one model result to its tile target", async () => {
    expect(decodedBase64Bytes("QUJDRA==")).toBe(4);

    const result = await normalizeGlobalPartitionImage("QUJDRA==", {
      targetWidth: 768,
      targetHeight: 384,
      maxWorkingBytes: 96 * 1024 * 1024,
      isCurrent: () => true
    });

    expect(result).toMatchObject({ base64: "QUJDRA==", width: 768, height: 384, encodedBytes: 4 });
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 768, 384);
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
  });

  it("rejects actual decoded dimensions before allocating an output canvas", async () => {
    imageWidth = 4096;
    imageHeight = 4096;

    await expect(normalizeGlobalPartitionImage("QUJDRA==", {
      targetWidth: 768,
      targetHeight: 768,
      maxWorkingBytes: 16 * 1024 * 1024
    })).rejects.toThrow("实际尺寸");

    expect(drawImage).not.toHaveBeenCalled();
  });

  it("rejects invalid model payloads without decoding", async () => {
    await expect(normalizeGlobalPartitionImage("not_base64", {
      targetWidth: 768,
      targetHeight: 768
    })).rejects.toThrow("base64");
  });
});
