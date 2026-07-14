import { afterEach, describe, expect, it, vi } from "vitest";
import { createPxdClient, normalizeOptions } from "./apiClient";
import { DEFAULT_SETTINGS } from "./settings";

afterEach(() => {
  vi.unstubAllGlobals();
});

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

  it("normalizes string options without dropping entries", () => {
    const result = normalizeOptions(["canny", " depth ", ""], ["module", "name"]);

    expect(result.map(({ label, value }) => ({ label, value }))).toEqual([
      { label: "canny", value: "canny" },
      { label: "depth", value: "depth" }
    ]);
  });
});

describe("fetchOptions", () => {
  it("reads official ControlNet wrapper responses and ignores module_detail", async () => {
    vi.stubGlobal("window", {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis)
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      const payloadByPath: Record<string, unknown> = {
        "/sdapi/v1/sd-models": [{ title: "Readable model", model_name: "model-key" }],
        "/sdapi/v1/sd-modules": [],
        "/sdapi/v1/loras": [],
        "/sdapi/v1/samplers": [],
        "/sdapi/v1/schedulers": [],
        "/controlnet/model_list": { model_list: ["control-a", "control-b"] },
        "/controlnet/module_list": {
          module_list: ["canny", "depth"],
          module_detail: { canny: { sliders: [] } }
        }
      };
      return new Response(JSON.stringify(payloadByPath[path] ?? []), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const options = await createPxdClient(DEFAULT_SETTINGS).fetchOptions();

    expect(options.models.map(({ label, value }) => ({ label, value }))).toEqual([
      { label: "Readable model", value: "model-key" }
    ]);
    expect(options.controlNetModels.map(({ label, value }) => ({ label, value }))).toEqual([
      { label: "control-a", value: "control-a" },
      { label: "control-b", value: "control-b" }
    ]);
    expect(options.controlNetModules.map(({ label, value }) => ({ label, value }))).toEqual([
      { label: "canny", value: "canny" },
      { label: "depth", value: "depth" }
    ]);
    const requestedPaths = fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname);
    expect(requestedPaths).not.toContain("/controlnet/models");
  });
});
