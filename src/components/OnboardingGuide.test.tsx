// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OnboardingGuide, { type OnboardingStep } from "./OnboardingGuide";

const steps: OnboardingStep[] = [
  { target: "[data-guide='test-anchor']", title: "第一步", body: "说明" },
  { target: "[data-guide='test-anchor']", title: "第二步", body: "完成" }
];

describe("OnboardingGuide", () => {
  let container: HTMLDivElement;
  let root: Root;
  let anchor: HTMLButtonElement;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    anchor = document.createElement("button");
    anchor.dataset.guide = "test-anchor";
    anchor.getBoundingClientRect = () => ({
      x: 10,
      y: 10,
      top: 10,
      left: 10,
      right: 110,
      bottom: 40,
      width: 100,
      height: 30,
      toJSON: () => ({})
    });
    document.body.appendChild(anchor);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    anchor.remove();
    container.remove();
    document.getElementById("pxd-overlay-root")?.remove();
  });

  it("anchors a non-modal, non-blocking guide and persists navigation", async () => {
    const onStepChange = vi.fn().mockResolvedValue(undefined);
    const onPause = vi.fn();
    await act(async () => {
      root.render(
        <OnboardingGuide
          open
          stepIndex={0}
          steps={steps}
          onStepChange={onStepChange}
          onComplete={vi.fn().mockResolvedValue(undefined)}
          onPause={onPause}
          onSkip={vi.fn().mockResolvedValue(undefined)}
        />
      );
      await Promise.resolve();
    });

    const dialog = document.querySelector<HTMLElement>(".onboarding-guide");
    const layer = document.querySelector<HTMLElement>(".onboarding-layer");
    expect(dialog?.getAttribute("aria-modal")).toBe("false");
    expect(document.activeElement).toBe(dialog);
    expect(layer?.className).toContain("onboarding-layer");
    expect(layer?.style.pointerEvents).toBe("none");
    expect(dialog?.style.pointerEvents).toBe("auto");
    expect(document.querySelector(".onboarding-spotlight")).not.toBeNull();

    const next = Array.from(dialog!.querySelectorAll("button")).find((button) => button.textContent === "下一步");
    await act(async () => next?.click());
    expect(onStepChange).toHaveBeenCalledWith(1);

    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(onPause).toHaveBeenCalledOnce();
  });

  it("disables progression when the step anchor is unavailable", async () => {
    anchor.remove();
    await act(async () => {
      root.render(
        <OnboardingGuide
          open
          stepIndex={0}
          steps={steps}
          onStepChange={vi.fn().mockResolvedValue(undefined)}
          onComplete={vi.fn().mockResolvedValue(undefined)}
          onPause={vi.fn()}
          onSkip={vi.fn().mockResolvedValue(undefined)}
        />
      );
      await Promise.resolve();
    });

    const next = Array.from(document.querySelectorAll<HTMLButtonElement>(".onboarding-guide button"))
      .find((button) => button.textContent === "下一步");
    expect(next?.disabled).toBe(true);
    expect(document.querySelector(".onboarding-guide__validation")?.textContent).toContain("目标暂不可用");
  });

  it.each(["Escape", "稍后", "跳过", "完成"])("restores focus after closing with %s", async (action) => {
    const ControlledGuide = () => {
      const [open, setOpen] = useState(true);
      const closeAsync = async () => setOpen(false);
      return (
        <OnboardingGuide
          open={open}
          stepIndex={action === "完成" ? 1 : 0}
          steps={steps}
          onStepChange={vi.fn().mockResolvedValue(undefined)}
          onComplete={closeAsync}
          onPause={() => setOpen(false)}
          onSkip={closeAsync}
        />
      );
    };

    anchor.focus();
    await act(async () => {
      root.render(<ControlledGuide />);
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(document.querySelector(".onboarding-guide"));

    await act(async () => {
      if (action === "Escape") {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      } else {
        const button = Array.from(document.querySelectorAll<HTMLButtonElement>(".onboarding-guide button"))
          .find((candidate) => candidate.textContent === action);
        button?.click();
      }
      await Promise.resolve();
    });

    expect(document.querySelector(".onboarding-guide")).toBeNull();
    expect(document.activeElement).toBe(anchor);
  });
});
