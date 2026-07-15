import { describe, expect, it } from "vitest";
import {
  createSceneSelection,
  listScenePacks,
  normalizeScenePack,
  parseSceneTemplate,
  resolveScenePrompt
} from "./scenePacks";

describe("scene pack catalog", () => {
  it("discovers bundled JSON packs and resolves their defaults without source changes", () => {
    const packs = listScenePacks();
    expect(packs.length).toBeGreaterThanOrEqual(2);
    expect(new Set(packs.map(({ id }) => id)).size).toBe(packs.length);
    for (const pack of packs) {
      const resolved = resolveScenePrompt(pack, createSceneSelection(pack));
      expect(resolved.errors).toEqual([]);
      expect(resolved.prompt).not.toMatch(/[{}]/);
      expect(resolved.prompt.length).toBeGreaterThan(20);
    }
  });

  it("supports legacy arrays and structured multi-select groups", () => {
    const pack = normalizeScenePack({
      id: "test-scene",
      name: "测试场景",
      promptTemplate: "Use {lighting}, {lens}, with {props}.",
      options: {
        lighting: ["soft light", "hard light"],
        lens: [{ id: "wide", label: "广角", prompt: "35mm lens" }],
        props: {
          label: "道具",
          multiple: true,
          required: false,
          values: [
            { id: "plant", label: "绿植", prompt: "one plant" },
            { id: "chair", label: "椅子", prompt: "one chair" }
          ],
          defaultValue: ["plant", "chair"]
        }
      }
    });
    expect(pack).not.toBeNull();
    const resolved = resolveScenePrompt(pack!, createSceneSelection(pack!));
    expect(resolved).toEqual({
      prompt: "Use soft light, 35mm lens, with one plant, one chair.",
      errors: []
    });
  });

  it("rejects malformed placeholders, unused groups, unsafe fragments, and invalid selections", () => {
    expect(parseSceneTemplate("bad {lighting").error).toBeTruthy();
    expect(normalizeScenePack({
      id: "bad", name: "Bad", promptTemplate: "{lighting}",
      options: { lighting: ["soft"], unused: ["x"] }
    })).toBeNull();
    expect(normalizeScenePack({
      id: "bad", name: "Bad", promptTemplate: "{lighting}",
      options: { lighting: ["inject {lens}"] }
    })).toBeNull();
    const pack = normalizeScenePack({
      id: "valid", name: "Valid", promptTemplate: "{lighting}", options: { lighting: ["soft"] }
    })!;
    expect(resolveScenePrompt(pack, { lighting: ["missing"] }).errors).toContain("灯光包含无效选项");
  });

  it("normalizes prompt markers once at the catalog boundary", () => {
    const pack = normalizeScenePack({
      id: "marker-scene",
      name: "Marker scene",
      promptTemplate: "base, {lighting}, @param:global:2, @param:disabled:0",
      options: {
        lighting: [{ id: "soft", label: "Soft", prompt: "soft light 【局部：0.376】" }]
      }
    })!;

    expect(resolveScenePrompt(pack, createSceneSelection(pack))).toEqual({
      prompt: "base, soft light 【局部：0.38】, @param:global:1.00",
      errors: []
    });
  });

  it("resolves 10000 deterministic generated templates without leaking placeholders", () => {
    let seed = 0x14c0ffee;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    for (let sample = 0; sample < 10_000; sample += 1) {
      const groupCount = 1 + Math.floor(random() * 6);
      const ids = Array.from({ length: groupCount }, (_, index) => `group_${index}`);
      const options = Object.fromEntries(ids.map((id, groupIndex) => [id, {
        label: `Group ${groupIndex}`,
        multiple: groupIndex % 2 === 1,
        required: groupIndex % 2 === 0,
        values: Array.from({ length: 1 + Math.floor(random() * 5) }, (_, valueIndex) => ({
          id: `value_${valueIndex}`,
          label: `Value ${valueIndex}`,
          prompt: `prompt-${sample}-${groupIndex}-${valueIndex}`
        }))
      }]));
      const pack = normalizeScenePack({
        id: `pack_${sample}`,
        name: `Pack ${sample}`,
        promptTemplate: ids.map((id) => `{${id}}`).join(" / ") + ` / {${ids[0]}}`,
        options
      });
      expect(pack).not.toBeNull();
      const selection = createSceneSelection(pack!);
      for (const group of pack!.options.filter(({ multiple }) => multiple)) {
        selection[group.id] = group.values.filter(() => random() > 0.5).map(({ id }) => id);
      }
      const resolved = resolveScenePrompt(pack!, selection);
      expect(resolved.errors).toEqual([]);
      expect(resolved.prompt).not.toMatch(/[{}]/);
      expect(resolved.prompt.split(pack!.options[0].values[0].prompt).length).toBeGreaterThanOrEqual(3);
    }
  });
});
