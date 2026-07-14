// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const renderer = vi.hoisted(() => ({
  render: vi.fn(),
  setSize: vi.fn(),
  dispose: vi.fn()
}));

vi.mock("three", async (importOriginal) => {
  const actual = await importOriginal<typeof import("three")>();
  class WebGLRenderer {
    outputColorSpace = "";
    toneMapping = 0;
    toneMappingExposure = 0;
    setPixelRatio = vi.fn();
    setSize = renderer.setSize;
    render = renderer.render;
    dispose = renderer.dispose;
  }
  return { ...actual, WebGLRenderer };
});

vi.mock("three/examples/jsm/controls/OrbitControls.js", async () => {
  const { Vector3 } = await import("three");
  class OrbitControls {
    target = new Vector3();
    enabled = true;
    enablePan = false;
    enableDamping = false;
    rotateSpeed = 1;
    zoomSpeed = 1;
    minDistance = 0;
    maxDistance = 0;
    minPolarAngle = 0;
    maxPolarAngle = 0;
    addEventListener = vi.fn();
    removeEventListener = vi.fn();
    update = vi.fn();
    dispose = vi.fn();
  }
  return { OrbitControls };
});

import { mountCameraViewport } from "../cameraRuntime";

describe("camera runtime WebGL recovery", () => {
  beforeEach(() => vi.clearAllMocks());

  it("clears the paused state and resizes after context restoration", () => {
    const canvas = document.createElement("canvas");
    const onStatus = vi.fn();
    const runtime = mountCameraViewport({
      canvas,
      value: { azimuth: 0, elevation: 0, distance: 2 },
      onChange: vi.fn(),
      onStatus
    });
    const initialRenderCount = renderer.render.mock.calls.length;
    const lost = new Event("webglcontextlost", { cancelable: true });

    canvas.dispatchEvent(lost);
    expect(lost.defaultPrevented).toBe(true);
    expect(onStatus).toHaveBeenLastCalledWith("3D 预览已暂停");

    canvas.dispatchEvent(new Event("webglcontextrestored"));
    expect(onStatus).toHaveBeenLastCalledWith(null);
    expect(renderer.setSize.mock.calls.length).toBeGreaterThan(1);
    expect(renderer.render.mock.calls.length).toBeGreaterThan(initialRenderCount);

    const callsBeforeDispose = onStatus.mock.calls.length;
    runtime.dispose();
    canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    expect(onStatus).toHaveBeenCalledTimes(callsBeforeDispose);
  });
});
