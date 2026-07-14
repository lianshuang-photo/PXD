import { describe, expect, it, vi } from "vitest";
import type { GenerationEngine } from "./generationEngine";
import {
  buildTiledUpscalePlan,
  executeTiledUpscale,
  incomingFeatherAlpha,
  type TiledUpscaleConfig
} from "./tiledUpscale";

const config: TiledUpscaleConfig = {
  scale: 2,
  tileSize: 1024,
  overlap: 256,
  feather: 128,
  edgeMode: "anchor",
  prompt: "enhance texture"
};

describe("tiled upscale geometry", () => {
  it("covers arbitrary dimensions without gaps and keeps every tile in bounds", () => {
    for (let width = 257; width <= 4097; width += 337) {
      for (let height = 311; height <= 3073; height += 419) {
        const plan = buildTiledUpscalePlan(width, height, config);
        expect(plan.tiles.length).toBeLessThanOrEqual(64);
        for (const tile of plan.tiles) {
          expect(tile.source.left).toBeGreaterThanOrEqual(0);
          expect(tile.source.top).toBeGreaterThanOrEqual(0);
          expect(tile.source.right).toBeLessThanOrEqual(width);
          expect(tile.source.bottom).toBeLessThanOrEqual(height);
          expect(tile.output.left).toBe(tile.source.left * 2);
          expect(tile.output.right).toBe(tile.source.right * 2);
          if (tile.column > 0) expect(tile.incomingOverlap.left).toBe(config.feather * config.scale);
          if (tile.row > 0) expect(tile.incomingOverlap.top).toBe(config.feather * config.scale);
        }
        for (const row of Array.from({ length: plan.rows }, (_, index) => index)) {
          const tiles = plan.tiles.filter((tile) => tile.row === row);
          expect(tiles[0].source.left).toBe(0);
          expect(tiles[tiles.length - 1].source.right).toBe(width);
          for (let index = 1; index < tiles.length; index += 1) {
            expect(tiles[index].source.left).toBeLessThanOrEqual(tiles[index - 1].source.right);
          }
        }
      }
    }
  });

  it("supports partial edge tiles and reports actual incoming overlap", () => {
    const plan = buildTiledUpscalePlan(1800, 1200, { ...config, edgeMode: "partial" });
    const last = plan.tiles[plan.tiles.length - 1];
    expect(last.source.right).toBe(1800);
    expect(last.source.bottom).toBe(1200);
    expect(last.source.right - last.source.left).toBeLessThan(1024);
    expect(last.incomingOverlap.left).toBe(256);
  });

  it("removes a redundant near-duplicate anchored edge tile without opening a gap", () => {
    const plan = buildTiledUpscalePlan(1800, 1024, config);
    expect(plan.columns).toBe(2);
    expect(plan.tiles.map((tile) => tile.source.left)).toEqual([0, 776]);
    const narrowGapPlan = buildTiledUpscalePlan(2050, 1024, config);
    const firstRow = narrowGapPlan.tiles.filter((tile) => tile.row === 0);
    for (let index = 1; index < firstRow.length; index += 1) {
      expect(firstRow[index].source.left).toBeLessThanOrEqual(firstRow[index - 1].source.right);
    }
  });

  it("keeps an intermediate tile when removing it would collapse the feathered seam", () => {
    const plan = buildTiledUpscalePlan(2048, 1024, config);
    expect(plan.tiles.map((tile) => tile.source.left)).toEqual([0, 768, 1024]);
    expect(plan.tiles[2].incomingOverlap.left).toBe(config.feather * config.scale);
  });

  it("uses a monotonic raised-cosine incoming feather with opaque exterior edges", () => {
    const values = Array.from({ length: 129 }, (_, x) => incomingFeatherAlpha(x, 50, 1024, 1024, 128, 0));
    expect(values[0]).toBe(0);
    expect(values[128]).toBe(1);
    for (let index = 1; index < values.length; index += 1) {
      expect(values[index]).toBeGreaterThanOrEqual(values[index - 1]);
    }
    expect(incomingFeatherAlpha(0, 0, 1024, 1024, 0, 0)).toBe(1);
  });

  it("rejects unsafe tile counts and working-set combinations", () => {
    expect(() => buildTiledUpscalePlan(20_000, 20_000, config)).toThrow("32768");
    expect(() => buildTiledUpscalePlan(4096, 4096, { ...config, tileSize: 2048, scale: 4 }))
      .toThrow("4096");
  });
});

describe("executeTiledUpscale", () => {
  const engine = {
    provider: "gemini",
    progressMode: "indeterminate",
    generate: vi.fn(),
    cancel: vi.fn(),
    cancelAll: vi.fn()
  } as unknown as GenerationEngine;

  it("streams one tile at a time into a non-destructive output document", async () => {
    let layerId = 100;
    const adapters = {
      readTile: vi.fn().mockResolvedValue("data:image/png;base64,SOURCE"),
      enhanceTile: vi.fn().mockResolvedValue("data:image/png;base64,ENHANCED"),
      featherTile: vi.fn().mockResolvedValue("data:image/png;base64,BLENDED"),
      createOutput: vi.fn().mockResolvedValue({ documentId: 9, previousDocumentId: 3 }),
      placeTile: vi.fn().mockImplementation(async () => ({ layerID: layerId++ })),
      finalize: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined)
    };
    const progress = vi.fn();

    const result = await executeTiledUpscale({
      engine,
      source: {
        documentId: 3,
        bounds: { left: 10, top: 20, right: 1810, bottom: 1220 },
        width: 1800,
        height: 1200
      },
      config,
      taskId: "upscale-1",
      adapters,
      isCurrent: () => true,
      onProgress: progress
    });

    expect(adapters.readTile).toHaveBeenCalledWith(
      3,
      { left: 10, top: 20, right: 1034, bottom: 1044 },
      "upscale-1"
    );
    expect(adapters.placeTile).toHaveBeenCalledTimes(result.plan.tiles.length);
    expect(adapters.finalize).toHaveBeenCalledWith(result.layerIds, 9, "upscale-1");
    expect(adapters.rollback).not.toHaveBeenCalled();
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({
      completed: result.plan.tiles.length,
      total: result.plan.tiles.length
    }));
  });

  it("rolls back the output document when cancellation wins during enhancement", async () => {
    let current = true;
    let resolveEnhancement!: (value: string) => void;
    const adapters = {
      readTile: vi.fn().mockResolvedValue("SOURCE"),
      enhanceTile: vi.fn().mockImplementation(() => new Promise<string>((resolve) => {
        resolveEnhancement = resolve;
      })),
      featherTile: vi.fn(),
      createOutput: vi.fn().mockResolvedValue({ documentId: 9, previousDocumentId: 3 }),
      placeTile: vi.fn(),
      finalize: vi.fn(),
      rollback: vi.fn().mockResolvedValue(undefined)
    };
    const run = executeTiledUpscale({
      engine,
      source: { documentId: 3, bounds: { left: 0, top: 0, right: 1024, bottom: 1024 }, width: 1024, height: 1024 },
      config,
      taskId: "cancel",
      adapters,
      isCurrent: () => current
    });
    await vi.waitFor(() => expect(adapters.enhanceTile).toHaveBeenCalledOnce());
    current = false;
    resolveEnhancement("LATE");

    await expect(run).rejects.toMatchObject({ code: "ENGINE_STALE" });
    expect(adapters.placeTile).not.toHaveBeenCalled();
    expect(adapters.rollback).toHaveBeenCalledWith(
      { documentId: 9, previousDocumentId: 3 },
      "cancel"
    );
  });

  it("surfaces rollback failure together with the original tile failure", async () => {
    const tileFailure = new Error("tile failed");
    const rollbackFailure = new Error("close failed");
    const adapters = {
      readTile: vi.fn().mockRejectedValue(tileFailure),
      enhanceTile: vi.fn(),
      featherTile: vi.fn(),
      createOutput: vi.fn().mockResolvedValue({ documentId: 9, previousDocumentId: 3 }),
      placeTile: vi.fn(),
      finalize: vi.fn(),
      rollback: vi.fn().mockRejectedValue(rollbackFailure)
    };

    await expect(executeTiledUpscale({
      engine,
      source: { documentId: 3, bounds: { left: 0, top: 0, right: 1024, bottom: 1024 }, width: 1024, height: 1024 },
      config,
      taskId: "rollback-failure",
      adapters,
      isCurrent: () => true
    })).rejects.toMatchObject({
      name: "TiledUpscaleRollbackError",
      originalError: tileFailure,
      rollbackError: rollbackFailure
    });
  });
});
