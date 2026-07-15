// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultLayout } from "../services/layoutExperience";
import LayoutSnapshotControls from "./LayoutSnapshotControls";

describe("LayoutSnapshotControls", () => {
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

  it("saves, applies, deletes, undoes, and resets through real controls", async () => {
    const callbacks = {
      save: vi.fn().mockResolvedValue(undefined),
      apply: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      undo: vi.fn().mockResolvedValue(undefined),
      reset: vi.fn().mockResolvedValue(undefined)
    };
    await act(async () => {
      root.render(
        <LayoutSnapshotControls
          snapshots={[{
            id: "snapshot-1",
            name: "修图布局",
            createdAt: 1,
            layout: createDefaultLayout()
          }]}
          canUndo
          busy={false}
          error={null}
          onSave={callbacks.save}
          onApply={callbacks.apply}
          onDelete={callbacks.delete}
          onUndo={callbacks.undo}
          onReset={callbacks.reset}
        />
      );
      await Promise.resolve();
    });

    const input = container.querySelector<HTMLInputElement>("[aria-label='布局快照名称']")!;
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      valueSetter?.call(input, "生成布局");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const button = (label: string) => Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((candidate) => candidate.textContent === label)!;

    await act(async () => button("保存").click());
    await act(async () => button("应用").click());
    await act(async () => button("删除").click());
    await act(async () => button("撤销切换").click());
    await act(async () => button("恢复默认").click());

    expect(callbacks.save).toHaveBeenCalledWith("生成布局");
    expect(callbacks.apply).toHaveBeenCalledWith("snapshot-1");
    expect(callbacks.delete).toHaveBeenCalledWith("snapshot-1");
    expect(callbacks.undo).toHaveBeenCalledOnce();
    expect(callbacks.reset).toHaveBeenCalledOnce();
  });
});
