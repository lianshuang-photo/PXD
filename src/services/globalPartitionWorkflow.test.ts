import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GenerationEngine } from "./generationEngine";
import { createGlobalPartitionPlan } from "./globalPartition";
import { executeGlobalPartitionWorkflow } from "./globalPartitionWorkflow";

const plan = () => createGlobalPartitionPlan({
  width: 2000,
  height: 1000,
  overlap: 80,
  targetMaxEdge: 768
});

const createEngine = () => ({
  provider: "gemini" as const,
  progressMode: "indeterminate" as const,
  generate: vi.fn(async ({ taskId }: { taskId?: string }) => ({ images: [`IMAGE_${taskId}`] })),
  cancel: vi.fn().mockReturnValue(true),
  cancelAll: vi.fn().mockReturnValue(0)
}) as unknown as GenerationEngine;

const normalizeImageImplementation = async (
  image: string,
  _options: { retainedBytes: number }
) => ({
  base64: image,
  dataUrl: `data:image/png;base64,${image}`,
  width: 768,
  height: 384,
  encodedBytes: image.length,
  estimatedWorkingBytes: image.length
});
const normalizeImage = vi.fn(normalizeImageImplementation);

describe("global partition workflow", () => {
  beforeEach(() => {
    normalizeImage.mockReset().mockImplementation(normalizeImageImplementation);
  });

  it("generates and normalizes captures sequentially with one prompt and places them in plan order", async () => {
    const engine = createEngine();
    const currentPlan = plan();
    let inFlight = 0;
    let maxInFlight = 0;
    (engine.generate as ReturnType<typeof vi.fn>).mockImplementation(async ({ taskId, prompt }) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return { images: [`RESULT_${taskId}_${prompt}`] };
    });
    const placeImages = vi.fn().mockResolvedValue({ layerIds: [41, 42], groupId: 50 });
    const progress: number[] = [];

    const result = await executeGlobalPartitionWorkflow({
      engine,
      documentId: 9,
      plan: currentPlan,
      prompt: "same global style",
      timeoutMs: 30_000,
      taskId: "partition",
      maskContract: 12,
      maskFeather: 24,
      maxWorkingBytes: 96 * 1024 * 1024,
      isCurrent: () => true,
      onProgress: (value) => progress.push(value),
      adapters: {
        captureRegion: vi.fn().mockImplementation(async (_documentId, tile) => ({
          tileId: tile.id,
          dataUrl: `data:image/png;base64,${tile.id}`,
          width: tile.targetWidth,
          height: tile.targetHeight
        })),
        normalizeImage,
        placeImages
      }
    });

    expect(maxInFlight).toBe(1);
    expect(engine.generate).toHaveBeenCalledTimes(2);
    expect(normalizeImage).toHaveBeenCalledTimes(2);
    expect(normalizeImage.mock.calls[0][1]).toMatchObject({ retainedBytes: 0 });
    expect(normalizeImage.mock.calls[1][1].retainedBytes).toBeGreaterThan(0);
    expect(engine.generate).toHaveBeenNthCalledWith(1, expect.objectContaining({
      prompt: "same global style",
      baseImageBase64: "left",
      taskId: "partition:tile:0"
    }));
    expect(placeImages).toHaveBeenCalledWith(
      9,
      currentPlan.tiles.map((tile, index) => ({
        tile,
        dataUrl: `data:image/png;base64,RESULT_partition:tile:${index}_same global style`
      })),
      expect.objectContaining({ overlap: currentPlan.overlap, maskContract: 12, maskFeather: 24, taskId: "partition" })
    );
    expect(result).toMatchObject({ layerIds: [41, 42], groupId: 50 });
    expect(progress[progress.length - 1]).toBe(1);
    expect(progress.every((value, index) => index === 0 || value >= progress[index - 1])).toBe(true);
  });

  it("cancels sibling requests and never places when one tile fails", async () => {
    const engine = createEngine();
    (engine.generate as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("model failed"))
      .mockResolvedValueOnce({ images: ["LATE"] });
    const currentPlan = plan();
    const placeImages = vi.fn();

    await expect(executeGlobalPartitionWorkflow({
      engine,
      documentId: 9,
      plan: currentPlan,
      prompt: "style",
      timeoutMs: 30_000,
      taskId: "partition",
      maskContract: 12,
      maskFeather: 24,
      maxWorkingBytes: 96 * 1024 * 1024,
      isCurrent: () => true,
      adapters: {
        captureRegion: vi.fn().mockImplementation(async (_documentId, tile) => ({
          tileId: tile.id,
          dataUrl: `data:image/png;base64,${tile.id}`,
          width: tile.targetWidth,
          height: tile.targetHeight
        })),
        normalizeImage,
        placeImages
      }
    })).rejects.toThrow("model failed");

    expect(engine.cancel).toHaveBeenCalledWith("partition:tile:0");
    expect(engine.cancel).toHaveBeenCalledWith("partition:tile:1");
    expect(placeImages).not.toHaveBeenCalled();
  });

  it("drops late model output after cancellation", async () => {
    const engine = createEngine();
    let current = true;
    let resolve!: (value: { images: string[] }) => void;
    (engine.generate as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise((done) => {
      resolve = done;
    }));
    const currentPlan = createGlobalPartitionPlan({
      width: 1000,
      height: 1000,
      overlap: 80,
      targetMaxEdge: 768
    });
    const placeImages = vi.fn();
    const run = executeGlobalPartitionWorkflow({
      engine,
      documentId: 9,
      plan: currentPlan,
      prompt: "style",
      timeoutMs: 30_000,
      taskId: "partition",
      maskContract: 12,
      maskFeather: 24,
      maxWorkingBytes: 96 * 1024 * 1024,
      isCurrent: () => current,
      adapters: {
        captureRegion: vi.fn().mockResolvedValue({
          tileId: "whole",
          dataUrl: "data:image/png;base64,whole",
          width: 768,
          height: 768
        }),
        normalizeImage,
        placeImages
      }
    });
    await vi.waitFor(() => expect(engine.generate).toHaveBeenCalledOnce());
    current = false;
    resolve({ images: ["LATE"] });

    await expect(run).rejects.toMatchObject({ code: "ENGINE_STALE" });
    expect(placeImages).not.toHaveBeenCalled();
  });
});
