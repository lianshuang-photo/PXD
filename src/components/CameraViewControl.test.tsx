import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import CameraViewControl from "./CameraViewControl";

describe("CameraViewControl", () => {
  it("renders snapped labels and emits axis changes", () => {
    const onChange = vi.fn();
    const renderer = create(
      <CameraViewControl
        value={{ azimuth: 44, elevation: -16, distance: 1.41 }}
        onChange={onChange}
        onGenerate={vi.fn()}
      />
    );
    expect(JSON.stringify(renderer.toJSON())).toContain("右前 3/4 · 轻微仰拍 · 特写");
    const azimuth = renderer.root.findByProps({ "aria-label": "方位" });
    act(() => azimuth.props.onChange({ target: { value: "90" } }));
    expect(onChange).toHaveBeenCalledWith({ azimuth: 90, elevation: -15, distance: 1.4 });
  });

  it("locks every handle and command while generation is running", () => {
    const onGenerate = vi.fn();
    const renderer = create(
      <CameraViewControl
        value={{ azimuth: 0, elevation: 0, distance: 2 }}
        running
        onChange={vi.fn()}
        onGenerate={onGenerate}
      />
    );
    for (const input of renderer.root.findAllByType("input")) expect(input.props.disabled).toBe(true);
    const button = renderer.root.findByType("button");
    expect(button.props.disabled).toBe(true);
    expect(button.children.join("")).toBe("生成中");
  });
});
