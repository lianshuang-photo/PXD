import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import type { AppSettings } from "../context/types";
import type { GenerationEngine, GenerationEngineFactories } from "../services/generationEngine";
import { DEFAULT_SETTINGS } from "../services/settings";
import { useGenerationEngine } from "./useGenerationEngine";

const makeFactories = () => {
  const forgeClient = {
    fetchOptions: vi.fn(),
    fetchProgress: vi.fn(),
    img2img: vi.fn()
  };
  const geminiClient = { editImage: vi.fn() };
  const createForgeClient = vi.fn().mockReturnValue(forgeClient);
  const createGeminiClient = vi.fn().mockReturnValue(geminiClient);
  return {
    factories: { createForgeClient, createGeminiClient } as unknown as GenerationEngineFactories,
    createForgeClient,
    createGeminiClient
  };
};

describe("useGenerationEngine", () => {
  it("memoizes equivalent settings and rebuilds for provider-specific changes", () => {
    const { factories, createForgeClient, createGeminiClient } = makeFactories();
    let current: GenerationEngine | null = null;

    const Harness = ({ settings }: { settings: AppSettings }) => {
      current = useGenerationEngine(settings, factories);
      return null;
    };

    const initial = { ...DEFAULT_SETTINGS };
    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(createElement(Harness, { settings: initial }));
    });
    const first = current;

    act(() => {
      renderer.update(createElement(Harness, {
        settings: { ...initial, brandColor: "#ffffff" }
      }));
    });
    expect(current).toBe(first);
    expect(createForgeClient).toHaveBeenCalledOnce();

    act(() => {
      renderer.update(createElement(Harness, {
        settings: { ...initial, sdEndpoint: "http://forge.test:7860" }
      }));
    });
    expect(current).not.toBe(first);
    expect(createForgeClient).toHaveBeenCalledTimes(2);

    const firstGeminiSettings: AppSettings = {
      ...initial,
      imageProvider: "gemini",
      offlineMode: false,
      geminiApiKey: "key-1"
    };
    act(() => {
      renderer.update(createElement(Harness, { settings: firstGeminiSettings }));
    });
    const firstGemini = current as unknown as GenerationEngine;
    expect(firstGemini.provider).toBe("gemini");
    expect(createGeminiClient).toHaveBeenCalledOnce();

    act(() => {
      renderer.update(createElement(Harness, {
        settings: { ...firstGeminiSettings, outputDirectory: "/unrelated" }
      }));
    });
    expect(current).toBe(firstGemini);
    expect(createGeminiClient).toHaveBeenCalledOnce();

    act(() => {
      renderer.update(createElement(Harness, {
        settings: { ...firstGeminiSettings, geminiApiKey: "key-2" }
      }));
    });
    expect(current).not.toBe(firstGemini);
    expect(createGeminiClient).toHaveBeenCalledTimes(2);

    act(() => renderer.unmount());
  });
});
