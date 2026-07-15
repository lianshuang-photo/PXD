// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GLOBAL_PARTITION_OPTIONS } from "../services/globalPartition";
import GlobalPartitionControls from "./GlobalPartitionControls";

describe("GlobalPartitionControls", () => {
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

  it("exposes tunable overlap, contract, and feather controls", () => {
    const onChange = vi.fn();
    act(() => root.render(
      <GlobalPartitionControls
        provider="gemini"
        options={DEFAULT_GLOBAL_PARTITION_OPTIONS}
        running={false}
        onChange={onChange}
        onRun={vi.fn()}
      />
    ));

    const sliders = container.querySelectorAll<HTMLInputElement>('input[type="range"]');
    expect(sliders).toHaveLength(3);
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(sliders[0], "160");
      sliders[0].dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith({ overlap: 160 });
  });

  it("gates the command to Gemini and locks controls while running", () => {
    const onRun = vi.fn();
    act(() => root.render(
      <GlobalPartitionControls
        provider="forge"
        options={DEFAULT_GLOBAL_PARTITION_OPTIONS}
        running={false}
        onChange={vi.fn()}
        onRun={onRun}
      />
    ));
    const button = container.querySelector<HTMLButtonElement>("button");
    expect(button?.disabled).toBe(true);
    expect(container.textContent).toContain("需要 Gemini");

    act(() => root.render(
      <GlobalPartitionControls
        provider="gemini"
        options={DEFAULT_GLOBAL_PARTITION_OPTIONS}
        running={true}
        onChange={vi.fn()}
        onRun={onRun}
      />
    ));
    expect(container.querySelector("fieldset")?.hasAttribute("disabled")).toBe(true);
    expect(container.textContent).toContain("分区处理中");
  });
});
