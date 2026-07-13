import { describe, expect, it } from "vitest";
import {
  formatPromptParamValue,
  parsePromptParams,
  replacePromptParam,
  sanitizePrompt
} from "./promptParams";

describe("prompt parameter parsing", () => {
  it("parses both marker syntaxes with Chinese names and whitespace", () => {
    const prompt = "light @param:主灯(强度): 0.50, tone 【色温：.25】";

    expect(parsePromptParams(prompt).map(({ name, value, syntax }) => ({ name, value, syntax }))).toEqual([
      { name: "主灯(强度)", value: 0.5, syntax: "at" },
      { name: "色温", value: 0.25, syntax: "bracket" }
    ]);
  });

  it("updates one duplicate marker by position without interpolating its name into a regex", () => {
    const prompt = "@param:强度.*:0.20 + @param:强度.*:0.80";
    const markers = parsePromptParams(prompt);

    expect(replacePromptParam(prompt, markers[1], 0.37)).toBe(
      "@param:强度.*:0.20 + @param:强度.*:0.37"
    );
  });

  it("clamps finite edits and ignores stale markers or non-finite values", () => {
    const prompt = "@param:强度:0.50";
    const marker = parsePromptParams(prompt)[0];

    expect(replacePromptParam(prompt, marker, 2)).toBe("@param:强度:1.00");
    expect(replacePromptParam(prompt, marker, -1)).toBe("@param:强度:0.00");
    expect(replacePromptParam(`${prompt}!`, marker, Number.NaN)).toBe(`${prompt}!`);
    expect(replacePromptParam("changed", marker, 0.2)).toBe("changed");
    expect(formatPromptParamValue(Number.POSITIVE_INFINITY)).toBeNull();
    expect(parsePromptParams("@param:坏值:NaN")).toEqual([]);
    expect(parsePromptParams("@param:坏值:0.5.6 @param:指数:1e2")).toEqual([]);
  });
});

describe("sanitizePrompt", () => {
  it("removes zero-valued modules while preserving non-zero markers", () => {
    expect(sanitizePrompt("base, @param:关闭:0.00, detail 【保留:0.40】")).toBe(
      "base, detail 【保留:0.40】"
    );
    expect(sanitizePrompt("【关闭：0】\n@param:也关闭: -0.0")).toBe("");
  });

  it("returns ordinary prompts byte-for-byte unchanged", () => {
    const prompt = "  ordinary prompt, no markers  ";
    expect(sanitizePrompt(prompt)).toBe(prompt);
  });
});
