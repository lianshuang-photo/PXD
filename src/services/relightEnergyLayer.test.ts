import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clampEnergyLayerPixels,
  estimateRelightEnergyPeakBytes,
  prepareRelightEnergyLayer,
  relightEnergyEncodedByteLength,
  RELIGHT_ENERGY_MAX_ENCODED_BYTES,
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

  it("enforces the exact 5 MiB decoded-byte boundary", () => {
    const exact = "A".repeat(Math.floor(RELIGHT_ENERGY_MAX_ENCODED_BYTES / 3) * 4) + "AAA=";
    const over = `${exact.slice(0, -1)}A`;
    expect(relightEnergyEncodedByteLength(exact)).toBe(RELIGHT_ENERGY_MAX_ENCODED_BYTES);
    expect(relightEnergyEncodedByteLength(over)).toBe(RELIGHT_ENERGY_MAX_ENCODED_BYTES + 1);
    expect(relightEnergyEncodedByteLength("A===")).toBeNull();
    expect(relightEnergyEncodedByteLength("A A=")).toBeNull();
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
    for (let base = 0; base <= 255; base += 1) {
      expect(softLightChannel(base, 128)).toBe(base);
      for (let contribution = 129; contribution <= 255; contribution += 1) {
        const blended = softLightChannel(base, contribution);
        expect(blended).toBeGreaterThanOrEqual(base);
        for (const alpha of [0, 1 / 255, 0.25, 0.5, 1]) {
          for (const opacity of [0, 0.25, 0.7, 1]) {
            expect(Math.round(base + alpha * opacity * (blended - base)))
              .toBeGreaterThanOrEqual(base);
          }
        }
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

  it("rejects pixels that do not exactly match the captured target", async () => {
    class TestImage {
      naturalWidth = 100;
      naturalHeight = 79;
      width = 100;
      height = 79;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal("Image", TestImage);
    vi.stubGlobal("document", { createElement: vi.fn() });

    await expect(prepareRelightEnergyLayer(
      "data:image/png;base64,TU9ERUw=",
      new AbortController().signal,
      { width: 100, height: 80 }
    )).rejects.toThrow("与捕获区域 100×80 不一致");
  });
});
