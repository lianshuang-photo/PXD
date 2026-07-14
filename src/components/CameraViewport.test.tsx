// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const renderer = vi.hoisted(() => ({
  failure: null as null | "controls" | "pixelRatio" | "setSize",
  render: vi.fn(),
  setSize: vi.fn(),
  dispose: vi.fn(),
  controlsDispose: vi.fn()
}));

vi.mock("three", async (importOriginal) => {
  const actual = await importOriginal<typeof import("three")>();
  class WebGLRenderer {
    outputColorSpace = "";
    toneMapping = 0;
    toneMappingExposure = 0;
    setPixelRatio = vi.fn(() => {
      if (renderer.failure === "pixelRatio") throw new Error("pixel ratio failed");
    });
    setSize = vi.fn((...args: unknown[]) => {
      renderer.setSize(...args);
      if (renderer.failure === "setSize") throw new Error("set size failed");
    });
    render = renderer.render;
    dispose = renderer.dispose;
  }
  return { ...actual, WebGLRenderer };
});

vi.mock("three/examples/jsm/controls/OrbitControls.js", async () => {
  const { Vector3 } = await import("three");
  class OrbitControls {
    constructor() {
      if (renderer.failure === "controls") throw new Error("controls failed");
    }
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
    dispose = renderer.controlsDispose;
  }
  return { OrbitControls };
});

import * as THREE from "three";
import { mountCameraViewport } from "../cameraRuntime";

describe("camera runtime WebGL recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    renderer.failure = null;
  });

  afterEach(() => vi.restoreAllMocks());

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

  it.each([
    ["controls", false, false],
    ["pixelRatio", true, false],
    ["setSize", true, true]
  ] as const)("cleans partial initialization after %s fails", (failure, hasControls, hasListeners) => {
    renderer.failure = failure;
    const canvas = document.createElement("canvas");
    const onStatus = vi.fn();
    const removeListener = vi.spyOn(canvas, "removeEventListener");
    const geometryDispose = vi.spyOn(THREE.BufferGeometry.prototype, "dispose");
    const materialDispose = vi.spyOn(THREE.Material.prototype, "dispose");

    expect(() => mountCameraViewport({
      canvas,
      value: { azimuth: 0, elevation: 0, distance: 2 },
      onChange: vi.fn(),
      onStatus
    })).toThrow();

    expect(renderer.dispose).toHaveBeenCalledOnce();
    expect(renderer.controlsDispose).toHaveBeenCalledTimes(hasControls ? 1 : 0);
    if (hasControls) {
      expect(geometryDispose).toHaveBeenCalled();
      expect(materialDispose).toHaveBeenCalled();
    }
    if (hasListeners) {
      expect(removeListener).toHaveBeenCalledWith("webglcontextlost", expect.any(Function));
      expect(removeListener).toHaveBeenCalledWith("webglcontextrestored", expect.any(Function));
    }
    canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    expect(onStatus).not.toHaveBeenCalled();
  });
});
