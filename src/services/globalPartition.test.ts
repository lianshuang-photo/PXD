import { describe, expect, it } from "vitest";
import {
  GLOBAL_PARTITION_BYTES_PER_TARGET_PIXEL,
  boundsHeight,
  boundsWidth,
  createGlobalPartitionPlan,
  resolveGlobalPartitionMask
} from "./globalPartition";

describe("global partition geometry", () => {
  it("uses the specified horizontal, vertical, and square strategies", () => {
    expect(createGlobalPartitionPlan({ width: 2000, height: 1000, overlap: 80, targetMaxEdge: 1024 }))
      .toMatchObject({ orientation: "horizontal", overlap: 80, tiles: [{ id: "left" }, { id: "right" }] });
    expect(createGlobalPartitionPlan({ width: 1000, height: 2000, overlap: 80, targetMaxEdge: 1024 }))
      .toMatchObject({ orientation: "vertical", overlap: 80, tiles: [{ id: "top" }, { id: "bottom" }] });
    expect(createGlobalPartitionPlan({ width: 1000, height: 1000, overlap: 80, targetMaxEdge: 1024 }))
      .toMatchObject({ orientation: "single", overlap: 0, tiles: [{ id: "whole" }] });
  });

  it("keeps odd-pixel cores exhaustive and overlaps only at the internal seam", () => {
    const horizontal = createGlobalPartitionPlan({
      width: 2001,
      height: 1000,
      overlap: 73,
      targetMaxEdge: 900
    });
    expect(horizontal.tiles[0].coreBounds.right).toBe(horizontal.tiles[1].coreBounds.left);
    expect(boundsWidth(horizontal.tiles[0].coreBounds) + boundsWidth(horizontal.tiles[1].coreBounds))
      .toBe(2001);
    expect(horizontal.tiles[0].captureBounds.right - horizontal.tiles[1].captureBounds.left)
      .toBe(146);
    expect(horizontal.tiles[0].captureBounds.left).toBe(0);
    expect(horizontal.tiles[1].captureBounds.right).toBe(2001);

    const vertical = createGlobalPartitionPlan({
      width: 999,
      height: 2001,
      overlap: 73,
      targetMaxEdge: 900
    });
    expect(vertical.tiles[0].coreBounds.bottom).toBe(vertical.tiles[1].coreBounds.top);
    expect(boundsHeight(vertical.tiles[0].coreBounds) + boundsHeight(vertical.tiles[1].coreBounds))
      .toBe(2001);
    expect(vertical.tiles[0].captureBounds.bottom - vertical.tiles[1].captureBounds.top)
      .toBe(146);
  });

  it("maintains bounds, coverage, aspect scale, and memory limits over deterministic samples", () => {
    let seed = 0x19c0ffee;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    for (let sample = 0; sample < 500; sample += 1) {
      const width = 32 + Math.floor(random() * 24_000);
      const height = 32 + Math.floor(random() * 24_000);
      const overlap = Math.floor(random() * 2_000);
      const targetMaxEdge = 128 + Math.floor(random() * 1_921);
      const maxWorkingBytes = (4 + Math.floor(random() * 93)) * 1024 * 1024;
      const plan = createGlobalPartitionPlan({
        width,
        height,
        overlap,
        targetMaxEdge,
        maxWorkingBytes
      });

      expect(plan.estimatedWorkingBytes).toBeLessThanOrEqual(maxWorkingBytes);
      const estimated = plan.tiles.reduce(
        (total, tile) => total + tile.targetWidth * tile.targetHeight * GLOBAL_PARTITION_BYTES_PER_TARGET_PIXEL,
        0
      );
      expect(plan.estimatedWorkingBytes).toBe(estimated);
      for (const tile of plan.tiles) {
        expect(tile.captureBounds.left).toBeGreaterThanOrEqual(0);
        expect(tile.captureBounds.top).toBeGreaterThanOrEqual(0);
        expect(tile.captureBounds.right).toBeLessThanOrEqual(width);
        expect(tile.captureBounds.bottom).toBeLessThanOrEqual(height);
        expect(boundsWidth(tile.captureBounds)).toBeGreaterThan(0);
        expect(boundsHeight(tile.captureBounds)).toBeGreaterThan(0);
        expect(tile.targetWidth).toBeGreaterThan(0);
        expect(tile.targetHeight).toBeGreaterThan(0);
        const sourceRatio = boundsWidth(tile.captureBounds) / boundsHeight(tile.captureBounds);
        const targetRatio = tile.targetWidth / tile.targetHeight;
        const relativeRatioError = Math.abs(targetRatio / sourceRatio - 1);
        expect(relativeRatioError).toBeLessThanOrEqual(
          2 / Math.min(tile.targetWidth, tile.targetHeight)
        );
      }
      if (plan.orientation === "horizontal") {
        expect(plan.tiles[0].coreBounds.right).toBe(plan.tiles[1].coreBounds.left);
        expect(boundsWidth(plan.tiles[0].coreBounds) + boundsWidth(plan.tiles[1].coreBounds)).toBe(width);
      } else if (plan.orientation === "vertical") {
        expect(plan.tiles[0].coreBounds.bottom).toBe(plan.tiles[1].coreBounds.top);
        expect(boundsHeight(plan.tiles[0].coreBounds) + boundsHeight(plan.tiles[1].coreBounds)).toBe(height);
      } else {
        expect(plan.tiles[0].coreBounds).toEqual({ left: 0, top: 0, right: width, bottom: height });
      }
    }
  });

  it("clamps overlap at tiny split boundaries and rejects invalid dimensions", () => {
    const plan = createGlobalPartitionPlan({ width: 65, height: 32, overlap: 999, targetMaxEdge: 512 });
    expect(plan.overlap).toBe(32);
    expect(plan.tiles.every((tile) => boundsWidth(tile.captureBounds) > 0)).toBe(true);
    expect(() => createGlobalPartitionPlan({ width: 0, height: 10, overlap: 1, targetMaxEdge: 10 }))
      .toThrow("文档宽度");
  });

  it("keeps the combined seam contraction and feather inside the overlap budget", () => {
    const plan = createGlobalPartitionPlan({
      width: 2000,
      height: 1000,
      overlap: 64,
      targetMaxEdge: 768
    });
    expect(resolveGlobalPartitionMask(plan, { maskContract: 48, maskFeather: 48 }))
      .toEqual({ contract: 48, feather: 16 });
    expect(resolveGlobalPartitionMask(plan, { maskContract: 100, maskFeather: 100 }))
      .toEqual({ contract: 64, feather: 0 });
  });
});
