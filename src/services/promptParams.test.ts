import { describe, expect, it } from "vitest";
import {
  formatPromptParamValue,
  normalizePromptParams,
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

  it("preserves raw out-of-range values and normalizes every marker consistently", () => {
    const prompt = "@param:过强:2 + 【过低：-0.5】 + @param:正常:.375";
    const markers = parsePromptParams(prompt);

    expect(markers.map(({ rawValue, value, raw }) => ({ rawValue, value, raw }))).toEqual([
      { rawValue: 2, value: 1, raw: "@param:过强:2" },
      { rawValue: -0.5, value: 0, raw: "【过低：-0.5】" },
      { rawValue: 0.375, value: 0.375, raw: "@param:正常:.375" }
    ]);
    expect(normalizePromptParams(prompt)).toBe(
      "@param:过强:1.00 + 【过低：0.00】 + @param:正常:0.38"
    );
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

  it("only cleans separators adjacent to removed markers", () => {
    const prompt = "  alpha  ; beta, @param:关闭:-2; gamma ;  delta  ";
    expect(sanitizePrompt(prompt)).toBe("  alpha  ; beta, gamma ;  delta  ");
  });

  it("normalizes retained marker values without changing unrelated text", () => {
    expect(sanitizePrompt("  high  ; @param:强度:2 ; keep  ")).toBe(
      "  high  ; @param:强度:1.00 ; keep  "
    );
  });
});
