// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import PromptParamControls from "./PromptParamControls";

describe("PromptParamControls wheel handling", () => {
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

  it("cancels the real wheel event and writes the stepped value", () => {
    let currentPrompt = "@param:主灯:0.50";
    const Harness = () => {
      const [prompt, setPrompt] = useState(currentPrompt);
      currentPrompt = prompt;
      return <PromptParamControls prompt={prompt} label="测试" onChange={setPrompt} />;
    };

    act(() => root.render(<Harness />));
    const range = container.querySelector<HTMLInputElement>('input[type="range"]');
    expect(range).not.toBeNull();

    const wheel = new WheelEvent("wheel", { deltaY: -1, bubbles: true, cancelable: true });
    act(() => range!.dispatchEvent(wheel));

    expect(wheel.defaultPrevented).toBe(true);
    expect(currentPrompt).toBe("@param:主灯:0.51");
  });
});
