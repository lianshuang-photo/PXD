import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import type { ReferenceImage } from "../services/referenceImages";
import ReferenceImageStrip from "./ReferenceImageStrip";

const image = (id: string): ReferenceImage => ({
  id,
  dataUrl: `data:image/png;base64,${id}`,
  width: 640,
  height: 480,
  capturedAt: "2026-07-14T00:00:00.000Z"
});

describe("ReferenceImageStrip", () => {
  it("renders ordered thumbnails and wires capture, move, delete, and clear controls", () => {
    const onCapture = vi.fn();
    const onMove = vi.fn();
    const onRemove = vi.fn();
    const onClear = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(createElement(ReferenceImageStrip, {
        images: [image("ONE"), image("TWO")],
        loading: false,
        aspectWarning: "比例差异较大",
        onCapture,
        onMove,
        onRemove,
        onClear
      }));
    });

    expect(renderer.root.findAllByType("img").map((node) => node.props.src)).toEqual([
      "data:image/png;base64,ONE",
      "data:image/png;base64,TWO"
    ]);
    act(() => renderer.root.findByProps({ "aria-label": "后移参考图 1" }).props.onClick());
    act(() => renderer.root.findByProps({ "aria-label": "删除参考图 2" }).props.onClick());
    const buttons = renderer.root.findAllByType("button");
    act(() => buttons.find((button) => button.children.join("") === "添加参考图")?.props.onClick());
    act(() => buttons.find((button) => button.children.join("") === "清空")?.props.onClick());

    expect(onMove).toHaveBeenCalledWith("ONE", "right");
    expect(onRemove).toHaveBeenCalledWith("TWO");
    expect(onCapture).toHaveBeenCalledOnce();
    expect(onClear).toHaveBeenCalledOnce();
    expect(renderer.root.findByProps({ role: "status" }).children.join("")).toContain("比例差异");
    act(() => renderer.unmount());
  });

  it("disables capture at capacity without resizing the strip", () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(createElement(ReferenceImageStrip, {
        images: [image("ONE"), image("TWO"), image("THREE"), image("FOUR")],
        loading: false,
        aspectWarning: null,
        onCapture: vi.fn(),
        onMove: vi.fn(),
        onRemove: vi.fn(),
        onClear: vi.fn()
      }));
    });

    const add = renderer.root.findAllByType("button")
      .find((button) => button.children.join("") === "添加参考图");
    expect(add?.props.disabled).toBe(true);
    expect(renderer.root.findAllByProps({ className: "reference-images__item" })).toHaveLength(4);
    act(() => renderer.unmount());
  });
});
