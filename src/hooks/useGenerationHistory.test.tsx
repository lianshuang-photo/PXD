import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GenerationHistoryEntry } from "../services/generationHistory";

const historyService = vi.hoisted(() => ({
  loadGenerationHistory: vi.fn(),
  saveGenerationHistory: vi.fn(),
  createGenerationThumbnail: vi.fn()
}));

vi.mock("../services/generationHistory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/generationHistory")>()),
  ...historyService
}));

import { useGenerationHistory } from "./useGenerationHistory";

interface TestParams {
  prompt: string;
  steps: number;
}

const persisted: GenerationHistoryEntry<TestParams> = {
  id: "persisted",
  ts: 100,
  provider: "forge",
  prompt: "old prompt",
  params: { prompt: "old prompt", steps: 20 },
  thumbnailDataUrl: "data:image/jpeg;base64,OLD"
};

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  historyService.loadGenerationHistory.mockResolvedValue([persisted]);
  historyService.createGenerationThumbnail.mockResolvedValue("data:image/jpeg;base64,NEW");
  historyService.saveGenerationHistory.mockResolvedValue(undefined);
});

describe("useGenerationHistory", () => {
  it("loads persisted entries and exposes a new generation immediately before persistence completes", async () => {
    let resolveSave: (() => void) | null = null;
    historyService.saveGenerationHistory.mockImplementation(() => new Promise<void>((resolve) => {
      resolveSave = resolve;
    }));
    const warnings = vi.fn();
    let current: ReturnType<typeof useGenerationHistory<TestParams>> | null = null;
    const Harness = () => {
      current = useGenerationHistory<TestParams>(warnings);
      return null;
    };
    const getCurrent = () => current as unknown as NonNullable<typeof current>;

    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(createElement(Harness));
    });
    await flush();
    expect(getCurrent().entries).toEqual([persisted]);

    await act(async () => {
      await getCurrent().record({
        provider: "gemini",
        prompt: "new prompt",
        params: { prompt: "new prompt", steps: 28 },
        resultDataUrl: "data:image/png;base64,FULL"
      });
    });

    expect(getCurrent().entries).toHaveLength(2);
    expect(getCurrent().entries[0]).toMatchObject({
      provider: "gemini",
      prompt: "new prompt",
      params: { prompt: "new prompt", steps: 28 },
      thumbnailDataUrl: "data:image/jpeg;base64,NEW"
    });
    expect(historyService.saveGenerationHistory).toHaveBeenCalledOnce();
    expect(warnings).not.toHaveBeenCalled();

    await act(async () => {
      resolveSave?.();
      await Promise.resolve();
    });
    act(() => renderer.unmount());
  });

  it("keeps in-memory history after a write failure and allows the next write to proceed", async () => {
    historyService.saveGenerationHistory
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce(undefined);
    const warnings = vi.fn();
    let current: ReturnType<typeof useGenerationHistory<TestParams>> | null = null;
    const Harness = () => {
      current = useGenerationHistory<TestParams>(warnings);
      return null;
    };
    const getCurrent = () => current as unknown as NonNullable<typeof current>;

    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(createElement(Harness));
    });
    await flush();
    await act(async () => {
      await getCurrent().record({
        provider: "forge",
        prompt: "first",
        params: { prompt: "first", steps: 10 },
        resultDataUrl: "data:image/png;base64,FIRST"
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getCurrent().entries[0].prompt).toBe("first");
    expect(getCurrent().error).toBe("生成历史保存失败：disk full");
    expect(warnings).toHaveBeenCalledWith("生成历史保存失败：disk full");

    await act(async () => {
      await getCurrent().record({
        provider: "gemini",
        prompt: "second",
        params: { prompt: "second", steps: 12 },
        resultDataUrl: "data:image/png;base64,SECOND"
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(historyService.saveGenerationHistory).toHaveBeenCalledTimes(2);
    expect(getCurrent().entries[0].prompt).toBe("second");
    act(() => renderer.unmount());
  });
});
