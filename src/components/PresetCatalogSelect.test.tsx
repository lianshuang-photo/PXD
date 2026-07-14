import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import type { PresetMeta } from "../services/presets";
import PresetCatalogSelect from "./PresetCatalogSelect";

const presets: PresetMeta[] = [
  {
    name: "自然光",
    fileName: "factory:natural.json",
    createdAt: "",
    kind: "gemini",
    category: "智能修图",
    subCategory: "光影",
    isFactory: true
  },
  {
    name: "我的重绘",
    fileName: "redraw.json",
    createdAt: "",
    kind: "forge",
    category: "基础生成",
    isFactory: false
  }
];

describe("PresetCatalogSelect", () => {
  it("groups catalog sources and exposes a factory read-only badge", () => {
    const onChange = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(createElement(PresetCatalogSelect, {
        presets,
        value: presets[0].fileName,
        onChange
      }));
    });

    expect(renderer.root.findAllByType("optgroup").map(({ props }) => props.label)).toEqual([
      "出厂 · 智能修图",
      "我的 · 基础生成"
    ]);
    expect(renderer.root.findByProps({ className: "preset-kind-badge preset-kind-badge--factory" }).children.join(""))
      .toBe("Gemini · 只读");
    const select = renderer.root.findByProps({ "aria-label": "预设目录" });
    act(() => select.props.onChange({ target: { value: "redraw.json" } }));
    expect(onChange).toHaveBeenCalledWith("redraw.json");
    act(() => renderer.unmount());
  });
});
