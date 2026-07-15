import { describe, expect, it } from "vitest";
import {
  ATLAS_WORKING_BYTES_PER_PIXEL,
  buildAtlasPrompt,
  createMultiRegionAtlasPlan,
  type AtlasRegionCapture
} from "./multiRegionAtlas";

const region = (index: number, width: number, height: number): AtlasRegionCapture => ({
  id: `region-${index}`,
  documentId: 7,
  bounds: { left: index * 100, top: index * 80, right: index * 100 + width, bottom: index * 80 + height },
  sourceWidth: width,
  sourceHeight: height,
  imageWidth: width,
  imageHeight: height,
  dataUrl: "data:image/png;base64,QQ==",
  encodedBytes: 1
});

describe("multi-region atlas geometry", () => {
  it("packs regions with non-overlapping content, frames, and fixed gutters", () => {
    const regions = [region(0, 700, 500), region(1, 420, 800), region(2, 600, 360), region(3, 300, 300)];
    const plan = createMultiRegionAtlasPlan({ regions, targetMaxEdge: 1536 });

    expect(plan.width).toBeLessThanOrEqual(1536);
    expect(plan.height).toBeLessThanOrEqual(1536);
    expect(plan.estimatedWorkingBytes).toBeLessThanOrEqual(96 * 1024 * 1024);
    for (const item of plan.items) {
      const source = regions[item.index];
      expect(item.contentBounds.right - item.contentBounds.left).toBe(Math.max(1, Math.floor(source.imageWidth * plan.scale)));
      expect(item.contentBounds.bottom - item.contentBounds.top).toBe(Math.max(1, Math.floor(source.imageHeight * plan.scale)));
      expect(item.contentBounds.left - item.frameBounds.left).toBe(plan.frame);
      expect(item.contentBounds.top - item.frameBounds.top).toBe(plan.frame);
    }
    for (let left = 0; left < plan.items.length; left += 1) {
      for (let right = left + 1; right < plan.items.length; right += 1) {
        const a = plan.items[left].frameBounds;
        const b = plan.items[right].frameBounds;
        const disjoint = a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
        expect(disjoint).toBe(true);
        const horizontalGap = Math.max(b.left - a.right, a.left - b.right);
        const verticalGap = Math.max(b.top - a.bottom, a.top - b.bottom);
        expect(horizontalGap >= plan.gap || verticalGap >= plan.gap).toBe(true);
      }
    }
  });

  it("maintains layout invariants over deterministic randomized inputs", () => {
    let seed = 0x21c0ffee;
    const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 0x100000000);
    for (let sample = 0; sample < 2_000; sample += 1) {
      const count = 1 + Math.floor(random() * 6);
      const regions = Array.from({ length: count }, (_, index) =>
        region(index, 32 + Math.floor(random() * 1800), 32 + Math.floor(random() * 1800))
      );
      const maxWorkingBytes = (24 + Math.floor(random() * 73)) * 1024 * 1024;
      const plan = createMultiRegionAtlasPlan({
        regions,
        targetMaxEdge: 512 + Math.floor(random() * 1537),
        maxWorkingBytes
      });
      expect(plan.estimatedWorkingBytes).toBeLessThanOrEqual(maxWorkingBytes);
      expect(plan.estimatedWorkingBytes).toBeGreaterThanOrEqual(plan.width * plan.height * ATLAS_WORKING_BYTES_PER_PIXEL);
      expect(plan.items).toHaveLength(count);
      expect(new Set(plan.items.map((item) => item.regionId)).size).toBe(count);
      for (const item of plan.items) {
        expect(item.frameBounds.left).toBeGreaterThanOrEqual(plan.padding);
        expect(item.frameBounds.top).toBeGreaterThanOrEqual(plan.padding);
        expect(item.frameBounds.right).toBeLessThanOrEqual(plan.width - plan.padding);
        expect(item.frameBounds.bottom).toBeLessThanOrEqual(plan.height - plan.padding);
      }
    }
  });

  it("emits a complete coordinate ledger and rejects cross-document captures", () => {
    const regions = [region(0, 640, 480), region(1, 320, 700)];
    const plan = createMultiRegionAtlasPlan({ regions, targetMaxEdge: 1024 });
    const prompt = buildAtlasPrompt("same editorial treatment", plan);
    expect(prompt).toContain("REGION_1: x=");
    expect(prompt).toContain("REGION_2: x=");
    expect(prompt).toContain("same pixel dimensions");
    expect(() => createMultiRegionAtlasPlan({
      regions: [regions[0], { ...regions[1], documentId: 9 }],
      targetMaxEdge: 1024
    })).toThrow("同一个 Photoshop 文档");
  });
});
