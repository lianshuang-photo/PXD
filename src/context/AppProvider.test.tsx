import { createElement, useContext } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppContextValue } from "./types";

const settingsService = vi.hoisted(() => ({
  loadSettings: vi.fn(),
  saveSettings: vi.fn(),
  applyBrandColor: vi.fn()
}));

vi.mock("../services/settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/settings")>()),
  ...settingsService
}));

import { DEFAULT_SETTINGS } from "../services/settings";
import { AppContext } from "./AppContext";
import { AppProvider } from "./AppProvider";

beforeEach(() => {
  vi.clearAllMocks();
  settingsService.loadSettings.mockResolvedValue(DEFAULT_SETTINGS);
  settingsService.saveSettings.mockResolvedValue(undefined);
});

describe("AppProvider settings patches", () => {
  it("serializes concurrent patches and merges each one against the latest saved settings", async () => {
    let releaseFirst!: () => void;
    settingsService.saveSettings
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        releaseFirst = resolve;
      }))
      .mockResolvedValueOnce(undefined);
    let context: AppContextValue | null = null;
    const Consumer = () => {
      context = useContext(AppContext) ?? null;
      return null;
    };

    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(createElement(AppProvider, null, createElement(Consumer)));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    let providerPatch!: Promise<void>;
    let colorPatch!: Promise<void>;
    act(() => {
      providerPatch = (context as unknown as AppContextValue).updateSettings({ imageProvider: "gemini" });
      colorPatch = (context as unknown as AppContextValue).updateSettings({ brandColor: "#123456" });
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(settingsService.saveSettings).toHaveBeenCalledTimes(1);

    await act(async () => {
      releaseFirst();
      await Promise.all([providerPatch, colorPatch]);
    });

    expect(settingsService.saveSettings).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ imageProvider: "gemini", brandColor: DEFAULT_SETTINGS.brandColor })
    );
    expect(settingsService.saveSettings).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ imageProvider: "gemini", brandColor: "#123456" })
    );
    expect((context as unknown as AppContextValue).settings).toMatchObject({
      imageProvider: "gemini",
      brandColor: "#123456"
    });
    expect((context as unknown as AppContextValue).saving).toBe(false);
    act(() => renderer.unmount());
  });
});
