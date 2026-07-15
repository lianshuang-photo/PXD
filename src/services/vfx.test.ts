import { describe, expect, it } from "vitest";
import {
  buildVfxPrompt,
  DEFAULT_VFX_CONFIG,
  normalizeVfxConfig,
  parseVfxConfig,
  vfxDegreeAdverb
} from "./vfx";

describe("VFX domain", () => {
  it("maps slider weights to stable Chinese degree adverbs", () => {
    expect([0, 0.2, 0.4, 0.6, 0.8, 1].map(vfxDegreeAdverb))
      .toEqual(["轻微", "较弱", "中等", "强烈", "极强", "极强"]);
  });

  it("normalizes bounded values, direction, and color", () => {
    expect(normalizeVfxConfig({
      ...DEFAULT_VFX_CONFIG,
      direction: -45,
      intensity: 4,
      density: -1,
      spread: Number.NaN,
      glow: 0.42,
      color: "BAD"
    })).toMatchObject({
      direction: 315,
      intensity: 1,
      density: 0,
      spread: 0,
      glow: 0.42,
      color: "#ff9f43"
    });
  });

  it("strictly parses persisted configs", () => {
    expect(parseVfxConfig(DEFAULT_VFX_CONFIG, { strict: true })).toEqual(DEFAULT_VFX_CONFIG);
    expect(parseVfxConfig({ ...DEFAULT_VFX_CONFIG, intensity: "0.5" }, { strict: true })).toBeNull();
    expect(parseVfxConfig({ ...DEFAULT_VFX_CONFIG, color: "orange" }, { strict: true })).toBeNull();
    expect(parseVfxConfig({ ...DEFAULT_VFX_CONFIG, effectType: "unknown" }, { strict: true })).toBeNull();
  });

  it("builds a structured prompt from every control", () => {
    const prompt = buildVfxPrompt({
      effectType: "lightning",
      direction: 225,
      intensity: 0.85,
      density: 0.45,
      spread: 0.65,
      glow: 0.25,
      color: "#35a7ff",
      useSelectionMask: true,
      transparentBackground: true,
      blendMode: "linearDodge"
    }, "arc behind the subject");
    expect(prompt).toContain("branching lightning arcs");
    expect(prompt).toContain("特效强度：极强 (0.85)");
    expect(prompt).toContain("粒子密度：中等 (0.45)");
    expect(prompt).toContain("影响范围：强烈 (0.65)");
    expect(prompt).toContain("发光程度：较弱 (0.25)");
    expect(prompt).toContain("exactly 225 degrees");
    expect(prompt).toContain("#35a7ff");
    expect(prompt).toContain("transparent alpha background");
    expect(prompt).toContain("non-destructive selection mask");
    expect(prompt).toContain("occlusion");
    expect(prompt).toContain("generate only the requested additive VFX overlay");
    expect(prompt).toContain("arc behind the subject");
  });

  it("requests a pure-black neutral background when transparency is disabled", () => {
    expect(buildVfxPrompt({ ...DEFAULT_VFX_CONFIG, transparentBackground: false }))
      .toContain("uniform pure-black background");
  });
});
