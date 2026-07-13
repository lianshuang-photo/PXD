import { afterEach, describe, expect, it, vi } from "vitest";
import { createPxdClient, type Img2ImgParams } from "./apiClient";
import { DEFAULT_SETTINGS } from "./settings";

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  });

const settings = {
  ...DEFAULT_SETTINGS,
  sdEndpoint: "http://forge.test:7860/"
};

const baseParams = {
  prompt: "portrait",
  negativePrompt: "blur",
  steps: 20,
  cfgScale: 7,
  batchSize: 1,
  width: 512,
  height: 512,
  loras: [{ name: "detail-xl", weight: 0.65 }]
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createPxdClient Forge protocols", () => {
  it("normalizes ControlNet string lists and falls back across Forge endpoints", async () => {
    const fetchMock = vi.fn().mockImplementation(async (urlValue: string) => {
      const url = new URL(urlValue);
      const path = `${url.pathname}${url.search}`;
      const responses: Record<string, Response> = {
        "/sdapi/v1/sd-models": jsonResponse([{ title: "Model Title", model_name: "model-id" }]),
        "/sdapi/v1/sd-modules": jsonResponse([]),
        "/sdapi/v1/loras": jsonResponse([{ name: "detail-xl", alias: "Detail XL" }]),
        "/sdapi/v1/samplers": jsonResponse([{ name: "Euler" }]),
        "/sdapi/v1/schedulers": jsonResponse([{ label: "Karras", name: "karras" }]),
        "/controlnet/model_list": jsonResponse({ message: "missing" }, 404),
        "/sdapi/v1/controlnet/model_list": jsonResponse({
          model_list: ["control_v11p_sd15_canny"]
        }),
        "/controlnet/module_list?alias_names=true": jsonResponse({
          module_list: ["canny", "depth_midas"]
        })
      };
      return responses[path] ?? jsonResponse({ message: `unexpected ${path}` }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    const options = await createPxdClient(settings).fetchOptions();

    expect(options.models).toMatchObject([{ label: "Model Title", value: "model-id" }]);
    expect(options.loras).toMatchObject([{ label: "detail-xl", value: "detail-xl" }]);
    expect(options.controlNetModels).toMatchObject([
      { label: "control_v11p_sd15_canny", value: "control_v11p_sd15_canny" }
    ]);
    expect(options.controlNetModules.map(({ value }) => value)).toEqual(["canny", "depth_midas"]);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toContain(
      "http://forge.test:7860/sdapi/v1/controlnet/model_list"
    );
  });

  it("sends LoRA and both ControlNet protocol shapes through img2img", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ images: ["OUTPUT"] }));
    vi.stubGlobal("fetch", fetchMock);
    const params: Img2ImgParams = {
      ...baseParams,
      baseImage: "data:image/png;base64,BASE",
      denoisingStrength: 0.4,
      controlNet: {
        model: "control-canny",
        module: "canny",
        weight: 0.8,
        image: "data:image/png;base64,CONTROL"
      }
    };

    await createPxdClient(settings).img2img(params);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://forge.test:7860/sdapi/v1/img2img");
    const body = JSON.parse(String(init.body));
    expect(body.prompt).toBe("portrait <lora:detail-xl:0.65>");
    expect(body.init_images).toEqual(["BASE"]);
    expect(body.controlnet_units[0]).toMatchObject({
      model: "control-canny",
      module: "canny",
      weight: 0.8,
      image: "CONTROL"
    });
    expect(body.alwayson_scripts.ControlNet.args).toEqual(body.controlnet_units);
  });

  it("routes text-only generation to txt2img with the shared Forge payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ images: ["OUTPUT"] }));
    vi.stubGlobal("fetch", fetchMock);

    await createPxdClient(settings).txt2img({
      ...baseParams,
      width: 768,
      height: 768
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://forge.test:7860/sdapi/v1/txt2img");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ width: 768, height: 768, batch_size: 1 });
    expect(body.prompt).toContain("<lora:detail-xl:0.65>");
    expect(body).not.toHaveProperty("init_images");
  });

  it("requests and preserves the Forge live progress preview", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      progress: 0.42,
      eta_relative: 3,
      current_image: "PREVIEW",
      textinfo: "Sampling"
    }));
    vi.stubGlobal("fetch", fetchMock);

    const progress = await createPxdClient(settings).fetchProgress();

    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://forge.test:7860/sdapi/v1/progress?skip_current_image=false"
    );
    expect(progress).toMatchObject({
      progress: 0.42,
      current_image: "PREVIEW",
      textinfo: "Sampling"
    });
  });
});
