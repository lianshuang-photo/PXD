// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TiledUpscaleDialog from "./TiledUpscaleDialog";

const button = (label: string) => Array.from(document.querySelectorAll("button")).find((candidate) =>
  candidate.textContent?.includes(label)
) as HTMLButtonElement;

describe("TiledUpscaleDialog", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders the actual colored grid and submits visible geometry controls", async () => {
    const onInspect = vi.fn().mockResolvedValue(true);
    const onRun = vi.fn().mockResolvedValue(true);
    act(() => root.render(
      <TiledUpscaleDialog
        provider="gemini"
        running={false}
        stopping={false}
        progress={null}
        sourceSize={{ width: 1800, height: 1200 }}
        onInspect={onInspect}
        onRun={onRun}
        onStop={vi.fn()}
        onClose={vi.fn()}
      />
    ));
    await act(async () => Promise.resolve());

    expect(document.querySelectorAll(".tiled-upscale__tile").length).toBe(4);
    expect(document.querySelector('[aria-label="2 列 2 行瓦片预览"]')).not.toBeNull();
    expect(document.body.textContent).toContain("1800×1200 → 3600×2400");
    await act(async () => button("开始分块放大").click());
    expect(onRun).toHaveBeenCalledWith(expect.objectContaining({
      scale: 2,
      tileSize: 1024,
      overlap: 192,
      feather: 96,
      edgeMode: "anchor"
    }));
  });

  it("uses a Forge-safe default and exposes stop during a running tile", () => {
    const props = {
      provider: "forge" as const,
      running: false,
      stopping: false,
      progress: null,
      sourceSize: { width: 1024, height: 1024 },
      onInspect: vi.fn().mockResolvedValue(true),
      onRun: vi.fn().mockResolvedValue(false),
      onStop: vi.fn(),
      onClose: vi.fn()
    };
    act(() => root.render(<TiledUpscaleDialog {...props} />));
    expect(button("开始分块放大").disabled).toBe(false);

    act(() => root.render(
      <TiledUpscaleDialog
        {...props}
        running={true}
        progress={{
          completed: 1,
          total: 4,
          phase: "enhancing",
          tile: {
            id: "tile-0-1",
            row: 0,
            column: 1,
            source: { left: 576, top: 0, right: 1024, bottom: 768 },
            output: { left: 1152, top: 0, right: 2048, bottom: 1536 },
            incomingOverlap: { left: 192, top: 0 }
          }
        }}
      />
    ));
    act(() => button("停止").click());
    expect(props.onStop).toHaveBeenCalledOnce();
    expect(document.querySelector('[aria-valuenow="25"]')).not.toBeNull();

    act(() => root.render(<TiledUpscaleDialog {...props} running={true} stopping={true} />));
    expect(button("停止中").disabled).toBe(true);
  });

  it("rejects a 1024px 4x tile over the memory budget and accepts 512px", async () => {
    act(() => root.render(
      <TiledUpscaleDialog
        provider="gemini"
        running={false}
        stopping={false}
        progress={null}
        sourceSize={{ width: 1800, height: 1200 }}
        onInspect={vi.fn().mockResolvedValue(true)}
        onRun={vi.fn().mockResolvedValue(true)}
        onStop={vi.fn()}
        onClose={vi.fn()}
      />
    ));
    await act(async () => Promise.resolve());
    const [scale, tileSize] = Array.from(document.querySelectorAll("select"));

    act(() => {
      scale.value = "4";
      scale.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("96 MiB");
    expect(button("开始分块放大").disabled).toBe(true);

    act(() => {
      tileSize.value = "512";
      tileSize.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(button("开始分块放大").disabled).toBe(false);
  });
});
