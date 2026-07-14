import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import CameraViewControl, { CameraViewportBoundary } from "./CameraViewControl";
import { createRetryableRuntimeLoader } from "./CameraViewport";

const expand = async (renderer: ReturnType<typeof create>) => {
  const toggle = renderer.root.findByProps({ "aria-controls": "camera-view-controls" });
  await act(async () => {
    toggle.props.onClick();
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe("CameraViewControl", () => {
  it("does not mount controls until the user expands the feature", () => {
    const renderer = create(
      <CameraViewControl
        value={{ azimuth: 0, elevation: 0, distance: 2 }}
        onChange={vi.fn()}
        onGenerate={vi.fn()}
      />
    );

    expect(renderer.root.findAllByType("canvas")).toHaveLength(0);
    expect(renderer.root.findAllByType("input")).toHaveLength(0);
    expect(renderer.root.findByProps({ "aria-controls": "camera-view-controls" }).props["aria-expanded"]).toBe(false);
  });

  it("renders snapped labels and emits axis changes after expansion", async () => {
    const onChange = vi.fn();
    const renderer = create(
      <CameraViewControl
        value={{ azimuth: 44, elevation: -16, distance: 1.41 }}
        onChange={onChange}
        onGenerate={vi.fn()}
      />
    );
    expect(JSON.stringify(renderer.toJSON())).toContain("右前 3/4 · 轻微仰拍 · 特写");
    await expand(renderer);
    expect(renderer.root.findByProps({ "aria-controls": "camera-view-controls" }).props["aria-expanded"]).toBe(true);
    expect(renderer.root.findByProps({ id: "camera-view-controls" }).props.className).toBe("camera-view__body");
    const azimuth = renderer.root.findByProps({ "aria-label": "方位" });
    act(() => azimuth.props.onChange({ target: { value: "90" } }));
    expect(onChange).toHaveBeenCalledWith({ azimuth: 90, elevation: -15, distance: 1.4 });
  });

  it("locks every handle and the generate command while generation is running", async () => {
    const onGenerate = vi.fn();
    const renderer = create(
      <CameraViewControl
        value={{ azimuth: 0, elevation: 0, distance: 2 }}
        running
        onChange={vi.fn()}
        onGenerate={onGenerate}
      />
    );
    await expand(renderer);
    for (const input of renderer.root.findAllByType("input")) expect(input.props.disabled).toBe(true);
    const button = renderer.root.findAllByType("button").find((candidate) =>
      candidate.props.className.includes("camera-view__generate")
    );
    expect(button).toBeDefined();
    expect(button!.props.disabled).toBe(true);
    expect(button!.children.join("")).toBe("生成中");
  });

  it("keeps the error overlay inside a positioned viewport wrapper", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const Throw = () => {
      throw new Error("viewport failed");
    };
    const renderer = create(
      <CameraViewportBoundary>
        <Throw />
      </CameraViewportBoundary>
    );

    const alert = renderer.root.findByProps({ role: "alert" });
    expect(alert.props.className).toBe("camera-view__fallback");
    expect(alert.parent?.props.className).toBe("camera-view__viewport");
    warn.mockRestore();
    error.mockRestore();
  });

  it("retries the runtime loader after a transient dynamic import failure", async () => {
    const runtime = { mount: vi.fn() };
    const load = vi.fn()
      .mockRejectedValueOnce(new Error("temporary import failure"))
      .mockResolvedValueOnce(runtime);
    const retry = createRetryableRuntimeLoader(load);

    await expect(retry()).rejects.toThrow("temporary import failure");
    await expect(retry()).resolves.toBe(runtime);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
