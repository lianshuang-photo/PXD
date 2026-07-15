import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultRelightLights } from "../services/relight";
import LightingEditor from "./LightingEditor";

const lights = createDefaultRelightLights();

const renderEditor = (overrides: Partial<Parameters<typeof LightingEditor>[0]> = {}) => {
  const props = {
    lights,
    opacity: 70,
    selectedId: lights[0].id,
    prompt: "portrait",
    disabled: false,
    providerSupported: true,
    status: "idle" as const,
    onSelect: vi.fn(),
    onAdd: vi.fn(),
    onRemove: vi.fn(),
    onChange: vi.fn(),
    onOpacityChange: vi.fn(),
    onPromptChange: vi.fn(),
    onRun: vi.fn(),
    ...overrides
  };
  let renderer: ReactTestRenderer;
  act(() => { renderer = create(<LightingEditor {...props} />); });
  return { renderer: renderer!, props };
};

describe("LightingEditor", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders the default key and rim lights", () => {
    const { renderer } = renderEditor();
    expect(renderer.root.findByProps({ "aria-label": "主光 1" })).toBeTruthy();
    expect(renderer.root.findByProps({ "aria-label": "轮廓光 2" })).toBeTruthy();
  });

  it("emits add, remove, selection and control changes", () => {
    const { renderer, props } = renderEditor();
    act(() => renderer.root.findByProps({ "aria-label": "添加灯光" }).props.onClick());
    act(() => renderer.root.findByProps({ "aria-label": "删除选中灯光" }).props.onClick());
    act(() => renderer.root.findByProps({ "aria-label": "轮廓光 2" }).props.onClick());
    act(() => renderer.root.findByProps({ "aria-label": "灯光角色" }).props.onChange({ target: { value: "fill" } }));
    act(() => renderer.root.findByProps({ "aria-label": "灯光类型" }).props.onChange({ target: { value: "area" } }));
    act(() => renderer.root.findByProps({ "aria-label": "灯光强度" }).props.onChange({ target: { value: "0.61" } }));
    act(() => renderer.root.findByProps({ "aria-label": "灯光色温" }).props.onChange({ target: { value: "6200" } }));
    act(() => renderer.root.findByProps({ "aria-label": "灯光方向" }).props.onChange({ target: { value: "210" } }));
    act(() => renderer.root.findByProps({ "aria-label": "能量层不透明度" }).props.onChange({ target: { value: "64" } }));
    expect(props.onAdd).toHaveBeenCalled();
    expect(props.onRemove).toHaveBeenCalledWith("key-1");
    expect(props.onSelect).toHaveBeenCalledWith("rim-1");
    expect(props.onChange).toHaveBeenCalledWith("key-1", { role: "fill" });
    expect(props.onChange).toHaveBeenCalledWith("key-1", { type: "area" });
    expect(props.onChange).toHaveBeenCalledWith("key-1", { intensity: 0.61 });
    expect(props.onChange).toHaveBeenCalledWith("key-1", { temperature: 6200 });
    expect(props.onChange).toHaveBeenCalledWith("key-1", { direction: 210 });
    expect(props.onOpacityChange).toHaveBeenCalledWith(64);
  });

  it("disables relighting for Forge, active work, and an empty plan", () => {
    const forge = renderEditor({ providerSupported: false });
    expect(forge.renderer.root.findByProps({ children: "重新打光" }).props.disabled).toBe(true);
    const running = renderEditor({ disabled: true });
    expect(running.renderer.root.findByProps({ children: "重新打光" }).props.disabled).toBe(true);
    expect(running.renderer.root.findByProps({ "aria-label": "能量层不透明度" }).props.disabled).toBe(true);
    const empty = renderEditor({ lights: [], selectedId: null });
    expect(empty.renderer.root.findByProps({ children: "重新打光" }).props.disabled).toBe(true);
  });

  it("converts dragged points to clamped normalized coordinates", () => {
    const { renderer, props } = renderEditor();
    const stage = renderer.root.findByProps({ "data-testid": "lighting-stage" });
    const stageElement = {
      closest: () => stageElement,
      getBoundingClientRect: () => ({ left: 10, top: 20, width: 200, height: 100 }),
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn()
    };
    const handle = renderer.root.findByProps({ "aria-label": "主光 1" });
    act(() => handle.props.onPointerDown({
      preventDefault: vi.fn(),
      pointerId: 1,
      clientX: 410,
      clientY: 0,
      currentTarget: { closest: () => stageElement, parentElement: stageElement }
    }));
    act(() => stage.props.onPointerMove({
      clientX: 410,
      clientY: 0,
      currentTarget: stageElement
    }));
    expect(props.onChange).toHaveBeenLastCalledWith("key-1", { x: 1, y: 0 });
  });
});
