import { describe, expect, it } from "vitest";
import {
  buildRelightPrompt,
  createDefaultRelightLights,
  normalizeRelightLight,
  pointFromStageCoordinates,
  relightDirectionVector
} from "./relight";

describe("relight geometry and prompt", () => {
  it("clamps stage coordinates and handles a zero-sized stage", () => {
    expect(pointFromStageCoordinates(250, -20, { left: 50, top: 20, width: 100, height: 100 }))
      .toEqual({ x: 1, y: 0 });
    expect(pointFromStageCoordinates(10, 10, { left: 0, top: 0, width: 0, height: 0 }))
      .toEqual({ x: 0.5, y: 0.5 });
  });

  it("normalizes all numeric light fields", () => {
    expect(normalizeRelightLight({
      id: "a", type: "spot", role: "key", x: -2, y: 3,
      direction: -90, intensity: 2, temperature: 12000
    })).toMatchObject({ x: 0, y: 1, direction: 270, intensity: 1, temperature: 10000 });
  });

  it("converts directions to vectors", () => {
    expect(relightDirectionVector(0)).toEqual({ x: 1, y: 0 });
    expect(relightDirectionVector(90).x).toBeCloseTo(0, 8);
    expect(relightDirectionVector(90).y).toBeCloseTo(1, 8);
  });

  it("starts with a key and rim light", () => {
    expect(createDefaultRelightLights().map((light) => light.role)).toEqual(["key", "rim"]);
  });

  it("builds an additive-only English prompt with exact controls and preservation constraints", () => {
    const prompt = buildRelightPrompt([{
      id: "key", type: "softbox", role: "key", x: 0.23, y: 0.41,
      direction: 135, intensity: 0.72, temperature: 4800
    }], "soft portrait catchlight");
    expect(prompt).toContain("only additive illumination");
    expect(prompt).toContain("do not darken any existing pixel");
    expect(prompt).toContain("hue, saturation, luminance, gamma");
    expect(prompt).toContain("white balance");
    expect(prompt).toContain("identity");
    expect(prompt).toContain("composition");
    expect(prompt).toContain("background geometry exactly");
    expect(prompt).toContain("visible lamps, fixtures");
    expect(prompt).toContain("annotation marks");
    expect(prompt).toContain("occlusion");
    expect(prompt).toContain("(23% from left, 41% from top)");
    expect(prompt).toContain("135 degrees");
    expect(prompt).toContain("intensity 0.72");
    expect(prompt).toContain("4800K");
    expect(prompt).toContain("soft portrait catchlight");
  });
});
