import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_VFX_CONFIG } from "../services/vfx";
import VfxEditor from "./VfxEditor";

const renderEditor = (overrides: Partial<Parameters<typeof VfxEditor>[0]> = {}) => {
  const onConfigChange = vi.fn();
  const props = {
    config: { ...DEFAULT_VFX_CONFIG },
    prompt: "cinematic",
    disabled: false,
    providerSupported: true,
    status: "idle" as const,
    onConfigChange,
    onPromptChange: vi.fn(),
    onRun: vi.fn(),
    ...overrides
  };
  let renderer: ReactTestRenderer;
  act(() => { renderer = create(<VfxEditor {...props} />); });
  return { renderer: renderer!, props, onConfigChange };
};

describe("VfxEditor", () => {
  it("emits every VFX parameter control", () => {
    const { renderer, onConfigChange } = renderEditor();
    const change = (label: string, value: string) => act(() =>
      renderer.root.findByProps({ "aria-label": label }).props.onChange({ target: { value } })
    );
    change("特效类型", "smoke");
    change("图层混合模式", "linearDodge");
    change("特效强度", "0.81");
    change("特效密度", "0.22");
    change("特效范围", "0.64");
    change("特效发光", "0.9");
    change("特效方向", "135");
    change("特效颜色", "#35a7ff");
    act(() => renderer.root.findByProps({ "aria-label": "使用选区遮罩" }).props.onChange({ target: { checked: false } }));
    act(() => renderer.root.findByProps({ "aria-label": "透明背景" }).props.onChange({ target: { checked: false } }));
    expect(onConfigChange.mock.calls.map(([patch]) => patch)).toEqual([
      { effectType: "smoke" },
      { blendMode: "linearDodge" },
      { intensity: 0.81 },
      { density: 0.22 },
      { spread: 0.64 },
      { glow: 0.9 },
      { direction: 135 },
      { color: "#35a7ff" },
      { useSelectionMask: false },
      { transparentBackground: false }
    ]);
  });

  it("passes supplementary prompt and run actions", () => {
    const { renderer, props } = renderEditor();
    act(() => renderer.root.findByProps({ "aria-label": "VFX 补充提示词" }).props.onChange({ target: { value: "more sparks" } }));
    act(() => renderer.root.findByProps({ children: "生成特效" }).props.onClick());
    expect(props.onPromptChange).toHaveBeenCalledWith("more sparks");
    expect(props.onRun).toHaveBeenCalled();
  });

  it("disables generation for Forge and while another task is active", () => {
    expect(renderEditor({ providerSupported: false }).renderer.root.findByProps({ children: "生成特效" }).props.disabled).toBe(true);
    expect(renderEditor({ disabled: true }).renderer.root.findByProps({ children: "生成特效" }).props.disabled).toBe(true);
  });
});
