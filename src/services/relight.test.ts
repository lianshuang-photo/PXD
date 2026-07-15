import { describe, expect, it } from "vitest";
import {
  buildRelightPrompt,
  createDefaultRelightLights,
  normalizeRelightConfig,
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

  it("defaults and clamps the non-destructive energy-layer opacity", () => {
    const lights = createDefaultRelightLights();
    expect(normalizeRelightConfig({ lights }, { strict: true })?.opacity).toBe(70);
    expect(normalizeRelightConfig({ lights, opacity: 140 }, { strict: true })?.opacity).toBe(100);
    expect(normalizeRelightConfig({ lights, opacity: Number.NaN }, { strict: true })).toBeNull();
  });

  it("builds a neutral-gray AOV prompt with exact reused lighting controls", () => {
    const prompt = buildRelightPrompt([{
      id: "key", type: "softbox", role: "key", x: 0.23, y: 0.41,
      direction: 135, intensity: 0.72, temperature: 4800
    }], "soft portrait catchlight");
    expect(prompt).toContain("lighting-contribution AOV");
    expect(prompt).toContain("RGB 128, 128, 128");
    expect(prompt).toContain("every channel of every output pixel must be 128 or higher");
    expect(prompt).toContain("Never encode shadows, negative light");
    expect(prompt).toContain("do not return a relit copy");
    expect(prompt).toContain("Soft Light blending");
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
