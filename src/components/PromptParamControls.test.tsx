import { useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import PromptParamControls from "./PromptParamControls";

describe("PromptParamControls", () => {
  it("writes slider, wheel, and manual edits back into the controlled prompt", () => {
    let currentPrompt = "@param:主灯:0.50 and 【补光:0.40】";
    let renderer: ReactTestRenderer;
    const Harness = () => {
      const [prompt, setPrompt] = useState(currentPrompt);
      currentPrompt = prompt;
      return <PromptParamControls prompt={prompt} label="测试" onChange={setPrompt} />;
    };

    act(() => {
      renderer = create(<Harness />);
    });
    const ranges = () => renderer!.root.findAllByProps({ type: "range" });
    const values = () => renderer!.root.findAllByProps({ type: "number" });
    expect(ranges()).toHaveLength(2);

    act(() => ranges()[0].props.onChange({ target: { value: "0.73" } }));
    expect(currentPrompt).toBe("@param:主灯:0.73 and 【补光:0.40】");

    const preventDefault = vi.fn();
    act(() => ranges()[1].props.onWheel({ deltaY: -1, preventDefault }));
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(currentPrompt).toBe("@param:主灯:0.73 and 【补光:0.41】");

    act(() => values()[0].props.onChange({ target: { value: "2" } }));
    expect(currentPrompt).toBe("@param:主灯:1.00 and 【补光:0.41】");

    const beforeInvalidEdit = currentPrompt;
    act(() => values()[1].props.onChange({ target: { value: "not-a-number" } }));
    act(() => values()[1].props.onChange({ target: { value: "" } }));
    expect(currentPrompt).toBe(beforeInvalidEdit);
  });
});
