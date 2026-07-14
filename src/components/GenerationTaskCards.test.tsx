import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import type { GenerationTaskSnapshot } from "../services/generationTaskPool";
import GenerationTaskCards from "./GenerationTaskCards";

const task = (overrides: Partial<GenerationTaskSnapshot> = {}): GenerationTaskSnapshot => ({
  id: "task-1",
  title: "人像修复",
  engine: "forge",
  status: "running",
  progress: 0.42,
  countdown: 18,
  autoReturn: true,
  cleanupPending: false,
  attempt: 1,
  createdAt: 1,
  ...overrides
});

const render = (tasks: GenerationTaskSnapshot[]) => {
  const handlers = {
    onCancel: vi.fn(),
    onRetry: vi.fn(),
    onCleanup: vi.fn(),
    onReturn: vi.fn(),
    onRemove: vi.fn(),
    onExtend: vi.fn(),
    onAutoReturnChange: vi.fn()
  };
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<GenerationTaskCards tasks={tasks} concurrency={4} {...handlers} />);
  });
  return { renderer, handlers };
};

const button = (renderer: ReactTestRenderer, text: string) =>
  renderer.root.findAllByType("button").find((candidate) => candidate.children.join("") === text);

describe("GenerationTaskCards", () => {
  it("shows progress and controls an active task independently", () => {
    const { renderer, handlers } = render([task()]);
    expect(JSON.stringify(renderer.toJSON())).toContain("42%");
    expect(renderer.root.findByProps({ className: "generation-task__countdown" }).children.join(""))
      .toBe("18s");
    act(() => button(renderer, "+10s")?.props.onClick());
    act(() => button(renderer, "停止")?.props.onClick());
    expect(handlers.onExtend).toHaveBeenCalledWith("task-1");
    expect(handlers.onCancel).toHaveBeenCalledWith("task-1");
  });

  it("offers manual return for cached images", () => {
    const { renderer, handlers } = render([
      task({ status: "awaiting-return", progress: 1, countdown: 0, images: ["IMAGE"] })
    ]);
    act(() => button(renderer, "回传")?.props.onClick());
    expect(handlers.onReturn).toHaveBeenCalledWith("task-1");
    expect(button(renderer, "停止")).toBeUndefined();
    expect(button(renderer, "移除")).toBeDefined();
  });

  it("offers retry and removal for failed tasks", () => {
    const { renderer, handlers } = render([task({ status: "error", error: "网络失败" })]);
    act(() => button(renderer, "重试")?.props.onClick());
    act(() => button(renderer, "移除")?.props.onClick());
    expect(handlers.onRetry).toHaveBeenCalledWith("task-1");
    expect(handlers.onRemove).toHaveBeenCalledWith("task-1");
  });

  it("requires cleanup before retrying a dirty task", () => {
    const { renderer, handlers } = render([
      task({ status: "error", cleanupPending: true, error: "Photoshop 清理未完成" })
    ]);
    expect(button(renderer, "重试")).toBeUndefined();
    act(() => button(renderer, "清理")?.props.onClick());
    expect(handlers.onCleanup).toHaveBeenCalledWith("task-1");
  });

  it("does not expose actions while cancellation is settling", () => {
    const { renderer } = render([
      task({ status: "cancelling", cleanupPending: true })
    ]);
    expect(button(renderer, "停止")).toBeUndefined();
    expect(button(renderer, "重试")).toBeUndefined();
    expect(button(renderer, "清理")).toBeUndefined();
    expect(button(renderer, "移除")).toBeUndefined();
  });
});
