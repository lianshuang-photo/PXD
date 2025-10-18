import type { AppSettings } from "../context/types";

export interface SdOption {
  label: string;
  value: string;
  raw: unknown;
}

export interface SdOptions {
  models: SdOption[];
  vaes: SdOption[];
  loras: SdOption[];
  samplers: SdOption[];
  schedulers: SdOption[];
  controlNetModels: SdOption[];
  controlNetModules: SdOption[];
}

export interface Txt2ImgParams {
  prompt: string;
  negativePrompt?: string;
  steps: number;
  cfgScale: number;
  sampler?: string;
  scheduler?: string;
  seed?: number;
  batchSize: number;
  width: number;
  height: number;
  model?: string;
  vae?: string;
  loras?: Array<{ name: string; weight: number }>;
  restoreFaces?: boolean;
  tiling?: boolean;
  clipSkip?: number;
  comments?: Record<string, unknown>;
  controlNet?: ControlNetPayload;
}

export interface Img2ImgParams extends Txt2ImgParams {
  denoisingStrength: number;
  baseImage: string;
  maskImage?: string;
}

export interface ControlNetPayload {
  model?: string;
  module?: string;
  weight?: number;
  guidanceStart?: number;
  guidanceEnd?: number;
  pixelPerfect?: boolean;
  image?: string;
}

export interface Txt2ImgResponse {
  images?: string[];
  parameters?: Record<string, unknown>;
  info?: string;
}

export interface ProgressResponse {
  progress: number;
  eta_relative: number;
  state?: Record<string, unknown> | null;
  current_image?: string | null;
  textinfo?: string | null;
  message?: string;
}

interface RequestOptions extends RequestInit {
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT = 15_000;

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  let timer: number;
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error("Request timed out")), timeoutMs);
  });
  try {
    const result = await Promise.race([promise, timeout]);
    return result;
  } finally {
    window.clearTimeout(timer);
  }
};

const requestJson = async <T>(url: string, init: RequestOptions = {}): Promise<T> => {
  const { timeoutMs = DEFAULT_TIMEOUT, ...rest } = init;
  const response = await withTimeout(fetch(url, rest), timeoutMs);
  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Request failed (${response.status}): ${message}`);
  }
  return (await response.json()) as T;
};

const sanitizeBaseUrl = (input: string) => input.replace(/\/+$/, "");

const toOption = (label: string, value: string, raw: unknown): SdOption => ({
  label,
  value,
  raw
});

const dataUrlToBase64 = (dataUrl: string) => {
  const [, base64] = dataUrl.split(",");
  return base64 ?? dataUrl;
};

const extractLabel = (item: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return "";
};

const normalizeOptions = (collection: unknown, labelKeys: string[], valueKey?: string): SdOption[] => {
  if (!Array.isArray(collection)) return [];
  return collection
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const objectItem = item as Record<string, unknown>;
      const label = extractLabel(objectItem, labelKeys) || valueKey ? String(objectItem[valueKey ?? labelKeys[0]] ?? "") : "";
      const value =
        valueKey && typeof objectItem[valueKey] === "string"
          ? (objectItem[valueKey] as string)
          : label;
      if (!label || !value) return null;
      return toOption(label, value, item);
    })
    .filter((item): item is SdOption => Boolean(item));
};

const buildTxt2ImgPayload = (params: Txt2ImgParams) => {
  const overrideSettings: Record<string, unknown> = {};
  if (params.model) overrideSettings.sd_model_checkpoint = params.model;
  if (params.vae) overrideSettings.sd_vae = params.vae;
  if (params.clipSkip && params.clipSkip > 0) overrideSettings.CLIP_stop_at_last_layers = params.clipSkip;

  const promptParts = [params.prompt || ""];
  if (params.loras && params.loras.length > 0) {
    for (const lora of params.loras) {
      if (!lora?.name) continue;
      const weight = typeof lora.weight === "number" && Number.isFinite(lora.weight) ? lora.weight : 1;
      promptParts.push(` <lora:${lora.name}:${weight}>`);
    }
  }

  const payload: Record<string, unknown> = {
    prompt: promptParts.join("").trim(),
    negative_prompt: params.negativePrompt ?? "",
    steps: params.steps,
    cfg_scale: params.cfgScale,
    ...(params.sampler
      ? {
          sampler_name: params.sampler,
          sampler_index: params.sampler
        }
      : {}),
    scheduler: params.scheduler,
    batch_size: params.batchSize,
    width: params.width,
    height: params.height,
    seed: params.seed ?? -1,
    restore_faces: params.restoreFaces ?? false,
    tiling: params.tiling ?? false,
    send_images: true,
    save_images: false,
    override_settings: overrideSettings,
    comments: params.comments ?? {}
  };

  if (params.controlNet?.model) {
    const unit: Record<string, unknown> = {
      enabled: true,
      model: params.controlNet.model,
      module: params.controlNet.module,
      weight: params.controlNet.weight ?? 1,
      guidance_start: params.controlNet.guidanceStart ?? 0,
      guidance_end: params.controlNet.guidanceEnd ?? 1,
      pixel_perfect: params.controlNet.pixelPerfect ?? true
    };
    if (params.controlNet.image) {
      unit.input_image = params.controlNet.image;
    }
    payload.controlnet_units = [unit];
    payload.alwayson_scripts = {
      ControlNet: {
        args: [unit]
      }
    };
  }

  return payload;
};

const buildImg2ImgPayload = (params: Img2ImgParams) => {
  const base = buildTxt2ImgPayload(params);
  return {
    ...base,
    init_images: [params.baseImage],
    denoising_strength: params.denoisingStrength,
    mask: params.maskImage ?? null
  };
};

export const createPxdClient = (settings: AppSettings) => {
  const baseURL = sanitizeBaseUrl(settings.sdEndpoint);

  const makeUrl = (path: string) => {
    if (!baseURL) {
      throw new Error("PXD backend endpoint is not configured");
    }
    return `${baseURL}${path}`;
  };

  const fetchJson = async <T>(path: string, init?: RequestOptions) => {
    return await requestJson<T>(makeUrl(path), init);
  };

  return {
    async ping(): Promise<boolean> {
      if (!baseURL) return false;
      try {
        await fetchJson("/sdapi/v1/sd-models", { method: "GET", timeoutMs: 5_000 });
        return true;
      } catch (error) {
        console.warn("Ping PXD endpoint failed", error);
        return false;
      }
    },
    async fetchOptions(): Promise<SdOptions> {
      const modelsPromise = fetchJson<unknown[]>("/sdapi/v1/sd-models").catch((error) => {
        console.warn("Failed to fetch models", error);
        return [];
      });
      const vaePromise = (async () => {
        const viaModules = await fetchJson<unknown[]>("/sdapi/v1/sd-modules").catch(() => null);
        if (viaModules && Array.isArray(viaModules)) return viaModules;
        return await fetchJson<unknown[]>("/sdapi/v1/sd-vae").catch((error) => {
          console.warn("Failed to fetch VAE list", error);
          return [];
        });
      })();
      const loraPromise = fetchJson<unknown[]>("/sdapi/v1/loras").catch((error) => {
        console.warn("Failed to fetch loras", error);
        return [];
      });
      const samplerPromise = fetchJson<unknown[]>("/sdapi/v1/samplers").catch((error) => {
        console.warn("Failed to fetch samplers", error);
        return [];
      });
      const schedulerPromise = fetchJson<unknown[]>("/sdapi/v1/schedulers").catch((error) => {
        console.warn("Failed to fetch schedulers", error);
        return [];
      });
      const controlNetModelsPromise = (async () => {
        const endpoints = [
          "/controlnet/model_list",
          "/controlnet/models",
          "/sdapi/v1/controlnet/models",
          "/controlnet/control_types"
        ];
        for (const endpoint of endpoints) {
          const result = await fetchJson<unknown>(endpoint).catch(() => null);
          if (!result) continue;
          if (Array.isArray(result)) return result;
          if (result && typeof result === "object") {
            const values = Object.values(result);
            if (Array.isArray(values)) return values.flat();
          }
        }
        return [];
      })();
      const controlNetModulesPromise = fetchJson<unknown[]>("/controlnet/module_list").catch((error) => {
        console.warn("Failed to fetch controlnet modules", error);
        return [];
      });

      const [models, vaes, loras, samplers, schedulers, controlNetModels, controlNetModules] = await Promise.all([
        modelsPromise,
        vaePromise,
        loraPromise,
        samplerPromise,
        schedulerPromise,
        controlNetModelsPromise,
        controlNetModulesPromise
      ]);

      return {
        models: normalizeOptions(models, ["title", "model_name", "name"], "model_name"),
        vaes: normalizeOptions(vaes, ["model_name", "name", "title"]),
        loras: normalizeOptions(loras, ["name", "alias"]),
        samplers: normalizeOptions(samplers, ["name"]),
        schedulers: normalizeOptions(schedulers, ["name", "label"]),
        controlNetModels: normalizeOptions(controlNetModels, ["model", "name"]),
        controlNetModules: normalizeOptions(controlNetModules, ["module", "name"])
      };
    },
    async txt2img(params: Txt2ImgParams): Promise<Txt2ImgResponse> {
      const payload = buildTxt2ImgPayload(params);
      return await fetchJson<Txt2ImgResponse>("/sdapi/v1/txt2img", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        timeoutMs: Math.max(DEFAULT_TIMEOUT, params.steps * 1000)
      });
    },
    async img2img(params: Img2ImgParams): Promise<Txt2ImgResponse> {
      const baseImage = dataUrlToBase64(params.baseImage);
      const payload = buildImg2ImgPayload({
        ...params,
        baseImage,
        maskImage: params.maskImage ? dataUrlToBase64(params.maskImage) : undefined,
        controlNet: params.controlNet
          ? {
              ...params.controlNet,
              image: params.controlNet.image ? dataUrlToBase64(params.controlNet.image) : undefined
            }
          : undefined
      });
      return await fetchJson<Txt2ImgResponse>("/sdapi/v1/img2img", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        timeoutMs: Math.max(DEFAULT_TIMEOUT, params.steps * 1000)
      });
    },
    async fetchProgress(): Promise<ProgressResponse | null> {
      try {
        return await fetchJson<ProgressResponse>("/sdapi/v1/progress", {
          method: "GET",
          timeoutMs: 5_000
        });
      } catch (error) {
        console.warn("Progress polling failed", error);
        return null;
      }
    }
  };
};
