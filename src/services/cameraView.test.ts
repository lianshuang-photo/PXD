import { describe, expect, it } from "vitest";
import {
  DEFAULT_CAMERA_VIEW,
  buildCameraViewPrompt,
  cameraPositionFor,
  describeCameraView,
  normalizeCameraView,
  snapCameraView
} from "./cameraView";

describe("camera view geometry", () => {
  it("snaps every axis to its documented range and interval", () => {
    expect(snapCameraView({ azimuth: 68, elevation: -37, distance: 1.73 })).toEqual({
      azimuth: 90,
      elevation: -30,
      distance: 1.8
    });
    expect(normalizeCameraView({ azimuth: 999, elevation: -999, distance: 99 })).toEqual({
      azimuth: 180,
      elevation: -90,
      distance: 4
    });
    expect(normalizeCameraView({ azimuth: "bad", elevation: null, distance: undefined })).toEqual({
      azimuth: 0,
      elevation: 0,
      distance: 2
    });
    expect(normalizeCameraView(null)).toEqual(DEFAULT_CAMERA_VIEW);
  });

  it("maps spherical camera coordinates around the subject", () => {
    expect(cameraPositionFor({ azimuth: 0, elevation: 0, distance: 2 })).toEqual({ x: 0, y: 0, z: 2 });
    expect(cameraPositionFor({ azimuth: 90, elevation: 0, distance: 2 })).toEqual({ x: 2, y: 0, z: 0 });
    expect(cameraPositionFor({ azimuth: -90, elevation: 0, distance: 2 })).toEqual({ x: -2, y: 0, z: 0 });
    expect(cameraPositionFor({ azimuth: 0, elevation: 90, distance: 2 })).toEqual({ x: 0, y: 2, z: 0 });
  });

  it("keeps the Chinese labels and English photography prompt on the same snapped state", () => {
    const state = { azimuth: -47, elevation: -14, distance: 0.65 };
    expect(describeCameraView(state).zh).toBe("左前 3/4 · 轻微仰拍 · 大特写");
    const prompt = buildCameraViewPrompt(state);
    expect(prompt).toContain("left front three-quarter view");
    expect(prompt).toContain("slightly low camera angle");
    expect(prompt).toContain("extreme close-up framing");
    expect(prompt).toContain("-45 degrees azimuth");
    expect(prompt).toContain("Preserve the subject's identity");
    expect(prompt).toContain("Change only the camera position");
    expect(prompt).toContain("Do not add, remove, replace, or redesign the subject");
  });
});
