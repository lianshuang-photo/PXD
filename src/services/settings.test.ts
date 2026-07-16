import { beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  readPreference: vi.fn(),
  readJsonFile: vi.fn(),
  writePreference: vi.fn(),
  writeJsonFile: vi.fn(),
  revealDataFolder: vi.fn()
}));

vi.mock("./uxpBridge", () => ({ bridge }));

import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "./settings";

beforeEach(() => {
  vi.clearAllMocks();
  bridge.readPreference.mockResolvedValue({});
  bridge.readJsonFile.mockResolvedValue(DEFAULT_SETTINGS);
  bridge.writePreference.mockResolvedValue(undefined);
  bridge.writeJsonFile.mockResolvedValue(undefined);
});

describe("generation task concurrency settings", () => {
  it("defaults to four concurrent network tasks", () => {
    expect(DEFAULT_SETTINGS.maxConcurrentTasks).toBe(4);
  });

  it.each([
    [0, 1],
    [3.9, 3],
    [12, 8],
    [Number.NaN, 4]
  ])("normalizes a loaded value of %s to %s", async (stored, expected) => {
    bridge.readJsonFile.mockResolvedValue({ ...DEFAULT_SETTINGS, maxConcurrentTasks: stored });
    expect((await loadSettings()).maxConcurrentTasks).toBe(expected);
  });

  it.each([
    [-2, 1],
    [6.8, 6],
    [99, 8],
    [Number.NaN, 4]
  ])("normalizes a saved value of %s to %s", async (value, expected) => {
    await saveSettings({ ...DEFAULT_SETTINGS, maxConcurrentTasks: value });
    expect(bridge.writePreference).toHaveBeenCalledWith(
      "settings.json",
      expect.objectContaining({ maxConcurrentTasks: expected })
    );
    expect(bridge.writeJsonFile).toHaveBeenCalledWith(
      "settings.json",
      expect.objectContaining({ maxConcurrentTasks: expected })
    );
  });
});
