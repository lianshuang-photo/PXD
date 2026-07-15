import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clampEnergyLayerPixels,
  estimateRelightEnergyPeakBytes,
  prepareRelightEnergyLayer,
  RELIGHT_ENERGY_MEMORY_BUDGET_BYTES,
  softLightChannel
} from "./relightEnergyLayer";

afterEach(() => vi.unstubAllGlobals());

describe("relight energy layer", () => {
  it("keeps the conservative worst-case peak below the 96 MiB budget", () => {
    expect(estimateRelightEnergyPeakBytes()).toBeLessThanOrEqual(
      RELIGHT_ENERGY_MEMORY_BUDGET_BYTES
    );
    expect(estimateRelightEnergyPeakBytes()).toBeGreaterThan(80 * 1024 * 1024);
  });

  it("clamps every RGB contribution to neutral gray without changing alpha", () => {
    const pixels = new Uint8ClampedArray([
      0, 127, 128, 17,
      129, 64, 255, 203
    ]);
    expect([...clampEnergyLayerPixels(pixels)]).toEqual([
      128, 128, 128, 17,
      129, 128, 255, 203
    ]);
  });

  it("makes neutral-gray Soft Light an identity and every brighter contribution non-decreasing", () => {
    for (const base of [0, 1, 32, 64, 127, 128, 192, 254, 255]) {
      expect(softLightChannel(base, 128)).toBe(base);
      for (const contribution of [129, 160, 192, 224, 255]) {
        expect(softLightChannel(base, contribution)).toBeGreaterThanOrEqual(base);
      }
    }
  });

  it("decodes, clamps, and re-encodes the actual canvas pixels", async () => {
    const pixels = new Uint8ClampedArray([
      15, 127, 128, 19,
      129, 230, 64, 211
    ]);
    const drawImage = vi.fn();
    const getImageData = vi.fn().mockReturnValue({ data: pixels });
    const putImageData = vi.fn();
    const toDataURL = vi.fn().mockReturnValue("data:image/png;base64,UFJFUEFSRUQ=");
    class TestImage {
      naturalWidth = 2;
      naturalHeight = 1;
      width = 2;
      height = 1;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal("Image", TestImage);
    vi.stubGlobal("document", {
      createElement: vi.fn().mockReturnValue({
        width: 0,
        height: 0,
        getContext: vi.fn().mockReturnValue({ drawImage, getImageData, putImageData }),
        toDataURL
      })
    });

    await expect(prepareRelightEnergyLayer(
      "data:image/png;base64,TU9ERUw=",
      new AbortController().signal
    )).resolves.toBe("data:image/png;base64,UFJFUEFSRUQ=");
    expect(drawImage).toHaveBeenCalledOnce();
    expect(getImageData).toHaveBeenCalledWith(0, 0, 2, 1);
    expect([...pixels]).toEqual([
      128, 128, 128, 19,
      129, 230, 128, 211
    ]);
    expect(putImageData).toHaveBeenCalledWith({ data: pixels }, 0, 0);
    expect(toDataURL).toHaveBeenCalledWith("image/png");
  });

  it("rejects invalid input and cancellation before decoding", async () => {
    const signal = new AbortController();
    signal.abort();
    vi.stubGlobal("Image", class TestImage {});
    vi.stubGlobal("document", { createElement: vi.fn() });
    await expect(prepareRelightEnergyLayer("not-an-image", signal.signal))
      .rejects.toThrow("格式无效");
    await expect(prepareRelightEnergyLayer("data:image/png;base64,TU9ERUw=", signal.signal))
      .rejects.toThrow("已取消");
  });
});
