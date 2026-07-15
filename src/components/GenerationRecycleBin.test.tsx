import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import type { RecycleBinEntry } from "../services/generationRecycleBin";
import GenerationRecycleBin from "./GenerationRecycleBin";

const entry: RecycleBinEntry = {
  taskId: "recover-task",
  prompt: "recover me",
  params: {},
  provider: "forge",
  status: "aborted",
  ts: 1,
  updatedAt: 2,
  assets: [{ fileName: "recover_01.png", mimeType: "image/png", byteLength: 3 }],
  context: { width: 64, height: 64 }
};

describe("GenerationRecycleBin", () => {
  it("browses recoverable images and exposes paste and rerun actions", async () => {
    const onPaste = vi.fn();
    const onRerun = vi.fn();
    const onReadPreview = vi.fn().mockResolvedValue("data:image/png;base64,AQID");
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <GenerationRecycleBin
          entries={[entry]}
          loading={false}
          error={null}
          onReadPreview={onReadPreview}
          onPaste={onPaste}
          onRerun={onRerun}
        />
      );
    });
    expect(onReadPreview).not.toHaveBeenCalled();
    const previewButton = renderer.root.findAllByType("button")[0];
    expect(previewButton.children.join("")).toBe("加载预览");
    await act(async () => {
      previewButton.props.onClick();
      await Promise.resolve();
    });
    expect(renderer.root.findByType("img").props.src).toBe("data:image/png;base64,AQID");
    const buttons = renderer.root.findAllByType("button");
    expect(buttons.map(({ children }) => children.join(""))).toEqual(["智能贴回", "重新生成"]);
    await act(async () => {
      buttons[0].props.onClick();
      buttons[1].props.onClick();
    });
    expect(onPaste).toHaveBeenCalledWith("recover-task");
    expect(onRerun).toHaveBeenCalledWith("recover-task");
    act(() => renderer.unmount());
  });
});
