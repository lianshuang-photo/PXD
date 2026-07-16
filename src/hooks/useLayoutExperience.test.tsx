// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const persistence = vi.hoisted(() => ({
  loadLayoutStore: vi.fn(),
  saveLayoutStore: vi.fn()
}));

vi.mock("../services/layoutExperience", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/layoutExperience")>()),
  loadLayoutStore: persistence.loadLayoutStore,
  saveLayoutStore: persistence.saveLayoutStore
}));

import { createDefaultLayoutStore } from "../services/layoutExperience";
import { useLayoutExperience } from "./useLayoutExperience";

describe("useLayoutExperience", () => {
  let container: HTMLDivElement;
  let root: Root;
  let experience: ReturnType<typeof useLayoutExperience>;

  beforeEach(async () => {
    vi.clearAllMocks();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    persistence.loadLayoutStore.mockResolvedValue(createDefaultLayoutStore());
    persistence.saveLayoutStore.mockResolvedValue(undefined);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const Harness = () => {
      experience = useLayoutExperience();
      return null;
    };
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("serializes changes and refreshes state only after each write completes", async () => {
    let releaseFirst!: () => void;
    persistence.saveLayoutStore
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        releaseFirst = resolve;
      }))
      .mockResolvedValueOnce(undefined);

    let first!: Promise<unknown>;
    let second!: Promise<unknown>;
    await act(async () => {
      first = experience.saveSnapshot("第一版");
      second = experience.saveSnapshot("第二版");
      await Promise.resolve();
    });

    expect(persistence.saveLayoutStore).toHaveBeenCalledTimes(1);
    expect(experience.store.snapshots).toEqual([]);
    expect(experience.saving).toBe(true);

    await act(async () => {
      releaseFirst();
      await Promise.all([first, second]);
    });

    expect(persistence.saveLayoutStore).toHaveBeenCalledTimes(2);
    expect(experience.store.snapshots.map((snapshot) => snapshot.name)).toEqual(["第二版", "第一版"]);
    expect(experience.saving).toBe(false);
  });

  it("keeps the last committed layout when persistence fails", async () => {
    persistence.saveLayoutStore.mockRejectedValueOnce(new Error("disk full"));
    let caught: unknown;

    await act(async () => {
      caught = await experience.saveSnapshot("不会提交").catch((error) => error);
    });

    expect(caught).toBeInstanceOf(Error);
    expect(experience.store.snapshots).toEqual([]);
    expect(experience.error).toContain("disk full");
    expect(experience.saving).toBe(false);
  });

  it("moves across adjacent visible sections while preserving hidden positions", async () => {
    await act(async () => {
      await experience.updateLayout({
        version: 1,
        order: ["presets", "batch", "models", "outputs", "generation", "controlnet", "prompts", "translation"],
        collapsed: []
      });
    });

    await act(async () => {
      await experience.moveSection(
        "presets",
        1,
        ["presets", "models", "generation", "controlnet", "prompts", "translation"]
      );
    });

    expect(experience.store.layout.order).toEqual([
      "models",
      "batch",
      "presets",
      "outputs",
      "generation",
      "controlnet",
      "prompts",
      "translation"
    ]);
  });
});
