import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { createSceneSelection, normalizeScenePack, resolveScenePrompt } from "../services/scenePacks";
import ScenePackControls from "./ScenePackControls";

const pack = normalizeScenePack({
  id: "studio",
  name: "Studio",
  promptTemplate: "Use {lighting} with {props}",
  options: {
    lighting: ["soft light", "hard light"],
    props: { multiple: true, required: false, values: ["a plant", "a chair"] }
  }
})!;

describe("ScenePackControls", () => {
  it("renders data-driven controls, preview, toggles, run, and undo", () => {
    const selection = createSceneSelection(pack);
    const prompt = resolveScenePrompt(pack, selection).prompt;
    const onChangeOption = vi.fn();
    const onRun = vi.fn();
    const onUndo = vi.fn();
    const onProtect = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(createElement(ScenePackControls, {
        packs: [pack], selectedPackId: pack.id, selection, prompt, errors: [],
        provider: "gemini", running: false, stopping: false,
        protectSubject: true, useSelectionReference: true, canUndo: true,
        onSelectPack: vi.fn(), onChangeOption,
        onProtectSubjectChange: onProtect, onUseSelectionReferenceChange: vi.fn(),
        onRun, onUndo
      }));
    });

    expect(renderer.root.findByProps({ "aria-label": "场景提示词预览" }).props.value).toBe(prompt);
    const selects = renderer.root.findAllByType("select");
    act(() => selects[1].props.onChange({ target: { value: "option-2" } }));
    expect(onChangeOption).toHaveBeenCalledWith("lighting", ["option-2"]);
    const checkboxes = renderer.root.findAllByType("input");
    act(() => checkboxes[0].props.onChange({ target: { checked: true } }));
    expect(onChangeOption).toHaveBeenCalledWith("props", ["option-1"]);
    act(() => checkboxes[2].props.onChange({ target: { checked: false } }));
    expect(onProtect).toHaveBeenCalledWith(false);
    const buttons = renderer.root.findAllByType("button");
    act(() => buttons[0].props.onClick());
    act(() => buttons[1].props.onClick());
    expect(onRun).toHaveBeenCalledOnce();
    expect(onUndo).toHaveBeenCalledOnce();
    act(() => renderer.unmount());
  });

  it("disables generation for Forge or invalid prompts", () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(createElement(ScenePackControls, {
        packs: [pack], selectedPackId: pack.id, selection: {}, prompt: "", errors: ["请选择灯光"],
        provider: "forge", running: false, stopping: false,
        protectSubject: false, useSelectionReference: false, canUndo: false,
        onSelectPack: vi.fn(), onChangeOption: vi.fn(),
        onProtectSubjectChange: vi.fn(), onUseSelectionReferenceChange: vi.fn(),
        onRun: vi.fn(), onUndo: vi.fn()
      }));
    });
    expect(renderer.root.findAllByType("button").every(({ props }) => props.disabled)).toBe(true);
    expect(renderer.root.findByProps({ className: "scene-pack__error" }).children.join(""))
      .toBe("请选择灯光");
    act(() => renderer.unmount());
  });
});
