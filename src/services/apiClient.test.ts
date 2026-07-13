import { describe, expect, it } from "vitest";
import { normalizeOptions } from "./apiClient";

describe("normalizeOptions", () => {
  it("keeps the readable title while using the backend model key as value", () => {
    const result = normalizeOptions(
      [{ title: "Readable checkpoint title", model_name: "checkpoint-id" }],
      ["title", "model_name", "name"],
      "model_name"
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      label: "Readable checkpoint title",
      value: "checkpoint-id"
    });
  });

  it("does not drop entries that have a title but omit the preferred value key", () => {
    const source = [
      { title: "Title only" },
      { model_name: "model-key-only" },
      { title: "Title and key", model_name: "model-key" }
    ];

    const result = normalizeOptions(source, ["title", "model_name", "name"], "model_name");

    expect(result).toHaveLength(source.length);
    expect(result.map(({ label, value }) => ({ label, value }))).toEqual([
      { label: "Title only", value: "Title only" },
      { label: "model-key-only", value: "model-key-only" },
      { label: "Title and key", value: "model-key" }
    ]);
  });
});
