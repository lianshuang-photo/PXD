// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PosterWizard from "./PosterWizard";

const clickButton = (label: string) => {
  const button = Array.from(document.querySelectorAll("button")).find((candidate) =>
    candidate.textContent?.includes(label)
  ) as HTMLButtonElement | undefined;
  expect(button).toBeDefined();
  act(() => button!.click());
  return button!;
};

const enterValue = (input: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const prototype = input instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(input, value);
  act(() => input.dispatchEvent(new Event("input", { bubbles: true })));
};

describe("PosterWizard", () => {
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

  it("navigates parameters, updates the stable preview, and submits a complete draft", async () => {
    const onGenerate = vi.fn().mockResolvedValue(true);
    act(() => root.render(
      <PosterWizard provider="gemini" running={false} onGenerate={onGenerate} onCancel={vi.fn()} onClose={vi.fn()} />
    ));

    const subject = document.querySelector<HTMLInputElement>('input[placeholder="例如：夏日咖啡新品"]');
    expect(subject).not.toBeNull();
    enterValue(subject!, "夏日咖啡新品");
    clickButton("文案");
    const copyInputs = document.querySelectorAll<HTMLInputElement>('.poster-wizard__copy-fields input');
    enterValue(copyInputs[0], "SUMMER DROP");
    enterValue(copyInputs[1], "七月限定风味");
    clickButton("构图");
    const split = document.querySelector<HTMLInputElement>('input[value="composition-split"]');
    act(() => split!.click());
    expect(document.querySelector(".poster-preview--split")).not.toBeNull();
    clickButton("预览");
    const square = document.querySelector<HTMLInputElement>('input[value="format-square"]');
    act(() => square!.click());
    expect((document.querySelector(".poster-preview") as HTMLElement).style.aspectRatio).toBe("1 / 1");

    await act(async () => clickButton("生成并贴入 PS"));

    expect(onGenerate).toHaveBeenCalledWith(expect.objectContaining({
      subject: "夏日咖啡新品",
      title: "SUMMER DROP",
      subtitle: "七月限定风味",
      selections: expect.objectContaining({
        composition: "composition-split",
        format: "format-square"
      })
    }));
  });

  it("disables Forge submission and exposes cancellation while running", () => {
    const onCancel = vi.fn();
    const props = {
      provider: "forge" as const,
      running: false,
      onGenerate: vi.fn().mockResolvedValue(false),
      onCancel,
      onClose: vi.fn()
    };
    act(() => root.render(<PosterWizard {...props} />));
    clickButton("预览");
    const submit = Array.from(document.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("生成并贴入 PS")
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(document.body.textContent).toContain("切换到 Gemini");

    act(() => root.render(<PosterWizard {...props} provider="gemini" running={true} />));
    clickButton("停止生成");
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
