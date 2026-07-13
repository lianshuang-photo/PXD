import { describe, expect, it } from "vitest";
import type { SelectionPixels } from "./photoshop";
import {
  REFERENCE_IMAGE_LIMIT,
  appendReferenceImage,
  estimateBase64Bytes,
  getReferenceAspectWarning,
  moveReferenceImage,
  referenceImagesToBase64,
  removeReferenceImage,
  type ReferenceImage
} from "./referenceImages";

const pixels = (suffix: string, width = 400, height = 300): SelectionPixels => ({
  dataUrl: `data:image/png;base64,REF${suffix}`,
  width,
  height,
  selectionBounds: { left: 0, top: 0, right: width, bottom: height }
});

describe("reference image collection", () => {
  it("preserves insertion order, supports reordering and deletion, and emits raw base64", () => {
    const first = appendReferenceImage([], pixels("ONE"));
    const second = appendReferenceImage(first, pixels("TWO"));
    const reordered = moveReferenceImage(second, second[1].id, "left");

    expect(referenceImagesToBase64(reordered)).toEqual(["REFTWO", "REFONE"]);
    expect(moveReferenceImage(reordered, reordered[0].id, "left")).toBe(reordered);
    expect(removeReferenceImage(reordered, reordered[0].id)).toEqual([reordered[1]]);
  });

  it("enforces the four-image capacity boundary", () => {
    let images: ReferenceImage[] = [];
    for (let index = 0; index < REFERENCE_IMAGE_LIMIT; index += 1) {
      images = appendReferenceImage(images, pixels(String(index)));
    }

    expect(() => appendReferenceImage(images, pixels("overflow"))).toThrow(/最多添加 4 张/);
  });

  it("rejects an individual image that exceeds the memory budget", () => {
    const oversized = pixels("oversized");
    oversized.dataUrl = `data:image/png;base64,${"A".repeat(6 * 1024 * 1024)}`;

    expect(estimateBase64Bytes(oversized.dataUrl)).toBeGreaterThan(4 * 1024 * 1024);
    expect(() => appendReferenceImage([], oversized)).toThrow(/体积过大/);
  });

  it("enforces the combined in-memory base64 budget", () => {
    const sharedDataUrl = `data:image/png;base64,${"A".repeat(5 * 1024 * 1024)}`;
    const current = Array.from({ length: 3 }, (_, index): ReferenceImage => ({
      id: `existing-${index}`,
      dataUrl: sharedDataUrl,
      width: 768,
      height: 768,
      capturedAt: "2026-07-14T00:00:00.000Z"
    }));
    const additional = pixels("TOTAL");
    additional.dataUrl = `data:image/png;base64,${"B".repeat(1536 * 1024)}`;

    expect(() => appendReferenceImage(current, additional)).toThrow(/总体积/);
  });

  it("identifies references whose aspect ratio differs materially from the main image", () => {
    const references = appendReferenceImage([], pixels("TALL", 200, 800));

    expect(getReferenceAspectWarning({ width: 800, height: 400 }, references)).toContain("参考图 1");
    expect(getReferenceAspectWarning({ width: 200, height: 800 }, references)).toBeNull();
  });
});
