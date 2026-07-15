import TestRenderer, { act } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import type { AtlasRegionCapture } from "../services/multiRegionAtlas";
import MultiRegionAtlasControls from "./MultiRegionAtlasControls";

const region = (id: string, width: number, height: number): AtlasRegionCapture => ({
  id,
  documentId: 7,
  bounds: { left: 0, top: 0, right: width, bottom: height },
  sourceWidth: width,
  sourceHeight: height,
  imageWidth: width,
  imageHeight: height,
  dataUrl: "data:image/png;base64,QQ==",
  encodedBytes: 1,
  selectionChannelName: `channel-${id}`
});

describe("MultiRegionAtlasControls", () => {
  it("renders stable region dimensions and routes add, remove, clear, and run actions", () => {
    const actions = { add: vi.fn(), remove: vi.fn(), clear: vi.fn(), run: vi.fn() };
    const renderer = TestRenderer.create(
      <MultiRegionAtlasControls
        provider="gemini"
        regions={[region("one", 640, 480), region("two", 300, 700)]}
        disabled={false}
        running={false}
        stopping={false}
        onAdd={actions.add}
        onRemove={actions.remove}
        onClear={actions.clear}
        onRun={actions.run}
      />
    );
    const spans = renderer.root.findAllByType("span").map((span) => span.children.join(""));
    expect(spans).toContain("640×480");
    expect(spans).toContain("2/6");
    const buttons = renderer.root.findAllByType("button");
    act(() => buttons.find((button) => button.children.join("") === "添加选区")?.props.onClick());
    act(() => buttons.find((button) => button.props["aria-label"] === "移除选区 1")?.props.onClick());
    act(() => buttons.find((button) => button.children.join("") === "清空")?.props.onClick());
    act(() => buttons.find((button) => button.children.join("") === "一次生成")?.props.onClick());
    expect(actions.add).toHaveBeenCalledOnce();
    expect(actions.remove).toHaveBeenCalledWith("one");
    expect(actions.clear).toHaveBeenCalledOnce();
    expect(actions.run).toHaveBeenCalledOnce();
  });

  it("locks every mutating control while Photoshop recovery is settling", () => {
    const renderer = TestRenderer.create(
      <MultiRegionAtlasControls
        provider="gemini"
        regions={[region("one", 640, 480)]}
        disabled={false}
        running={true}
        stopping={true}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        onClear={vi.fn()}
        onRun={vi.fn()}
      />
    );
    expect(renderer.root.findByType("fieldset").props.disabled).toBe(true);
    expect(JSON.stringify(renderer.toJSON())).toContain("正在恢复");
  });
});
