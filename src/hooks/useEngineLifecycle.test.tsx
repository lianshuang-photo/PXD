import { createElement, startTransition, Suspense } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GenerationEngine } from "../services/generationEngine";
import { useEngineLifecycle } from "./useEngineLifecycle";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const makeEngine = (
  provider: GenerationEngine["provider"],
  fetchProgress?: GenerationEngine["fetchProgress"]
): GenerationEngine => ({
  provider,
  progressMode: provider === "forge" ? "determinate" : "indeterminate",
  generate: vi.fn(),
  cancel: vi.fn().mockReturnValue(false),
  cancelAll: vi.fn().mockReturnValue(0),
  fetchProgress
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useEngineLifecycle", () => {
  it("drops an in-flight Forge progress result and stops polling after switching to Gemini", async () => {
    vi.useFakeTimers();
    let resolveProgress: ((value: { progress: number; eta_relative: number }) => void) | null = null;
    const fetchProgress = vi.fn().mockImplementation(() => new Promise((resolve) => {
      resolveProgress = resolve;
    }));
    const forge = makeEngine("forge", fetchProgress);
    const gemini = makeEngine("gemini");
    const onProgress = vi.fn();
    let lifecycle: ReturnType<typeof useEngineLifecycle> | null = null;
    const Harness = ({ engine }: { engine: GenerationEngine }) => {
      lifecycle = useEngineLifecycle(engine);
      return null;
    };

    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(createElement(Harness, { engine: forge }));
    });
    const mountedLifecycle = lifecycle as unknown as ReturnType<typeof useEngineLifecycle>;
    act(() => {
      mountedLifecycle.startPolling(mountedLifecycle.token, onProgress);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(fetchProgress).toHaveBeenCalledOnce();

    act(() => {
      renderer.update(createElement(Harness, { engine: gemini }));
    });
    await act(async () => {
      resolveProgress?.({ progress: 0.8, eta_relative: 1 });
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(3_000);
    });

    expect(onProgress).not.toHaveBeenCalled();
    expect(fetchProgress).toHaveBeenCalledOnce();
    act(() => renderer.unmount());
  });

  it("invalidates late options commits during rapid provider and endpoint switches", () => {
    const forgeOne = makeEngine("forge", vi.fn());
    const gemini = makeEngine("gemini");
    const forgeTwo = makeEngine("forge", vi.fn());
    let lifecycle: ReturnType<typeof useEngineLifecycle> | null = null;
    const Harness = ({ engine }: { engine: GenerationEngine }) => {
      lifecycle = useEngineLifecycle(engine);
      return null;
    };

    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(createElement(Harness, { engine: forgeOne }));
    });
    const getLifecycle = () => lifecycle as unknown as ReturnType<typeof useEngineLifecycle>;
    const firstToken = getLifecycle().token;
    act(() => renderer.update(createElement(Harness, { engine: gemini })));
    const secondToken = getLifecycle().token;
    act(() => renderer.update(createElement(Harness, { engine: forgeTwo })));
    const currentToken = getLifecycle().token;

    expect(currentToken).not.toBe(firstToken);
    expect(currentToken).not.toBe(secondToken);
    expect(getLifecycle().isCurrent(firstToken)).toBe(false);
    expect(getLifecycle().isCurrent(secondToken)).toBe(false);
    expect(getLifecycle().commitIfCurrent(firstToken, vi.fn())).toBe(false);
    expect(getLifecycle().commitIfCurrent(currentToken, vi.fn())).toBe(true);
    act(() => renderer.unmount());
  });

  it("keeps the committed token current when a concurrent engine render is abandoned", async () => {
    const forge = makeEngine("forge", vi.fn());
    const gemini = makeEngine("gemini");
    const never = new Promise<void>(() => undefined);
    const renderedEngines: GenerationEngine[] = [];
    let lifecycle: ReturnType<typeof useEngineLifecycle> | null = null;
    const Harness = ({ engine, suspend }: { engine: GenerationEngine; suspend?: boolean }) => {
      lifecycle = useEngineLifecycle(engine);
      renderedEngines.push(engine);
      if (suspend) throw never;
      return null;
    };
    const App = ({ engine, suspend }: { engine: GenerationEngine; suspend?: boolean }) =>
      createElement(
        Suspense,
        { fallback: null },
        createElement(Harness, { engine, suspend })
      );

    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(App, { engine: forge }), {
        unstable_isConcurrent: true
      } as unknown as TestRenderer.TestRendererOptions);
    });
    const committedLifecycle = lifecycle as unknown as ReturnType<typeof useEngineLifecycle>;
    const committedToken = committedLifecycle.token;

    await act(async () => {
      startTransition(() => {
        renderer.update(createElement(App, { engine: gemini, suspend: true }));
      });
      await Promise.resolve();
    });
    expect(renderedEngines).toContain(gemini);

    await act(async () => {
      renderer.update(createElement(App, { engine: forge }));
    });
    const currentLifecycle = lifecycle as unknown as ReturnType<typeof useEngineLifecycle>;
    expect(currentLifecycle.token).toBe(committedToken);
    expect(currentLifecycle.isCurrent(committedToken)).toBe(true);
    expect(currentLifecycle.commitIfCurrent(committedToken, vi.fn())).toBe(true);
    act(() => renderer.unmount());
  });
});
