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
  taskId?: string;
}

export interface RequestTaskOptions {
  taskId?: string;
  signal?: AbortSignal;
}

export class PxdRequestCancelledError extends Error {
  readonly code = "CANCELLED";
  readonly taskId?: string;

  constructor(taskId?: string) {
    super(taskId ? `Request cancelled for task ${taskId}` : "Request cancelled");
    this.name = "PxdRequestCancelledError";
    this.taskId = taskId;
  }
}

export class PxdRequestTimeoutError extends Error {
  readonly code = "TIMEOUT";
  readonly timeoutMs: number;
  readonly taskId?: string;

  constructor(timeoutMs: number, taskId?: string) {
    super(`Request timed out after ${timeoutMs}ms`);
    this.name = "PxdRequestTimeoutError";
    this.timeoutMs = timeoutMs;
    this.taskId = taskId;
  }
}

export const isPxdRequestCancelledError = (error: unknown): error is PxdRequestCancelledError =>
  error instanceof PxdRequestCancelledError;

const rethrowCancellation = (error: unknown) => {
  if (isPxdRequestCancelledError(error)) throw error;
};

const DEFAULT_TIMEOUT = 15_000;
const BASE_RESOLUTION = 512 * 512;
const BASE_TIMEOUT_BUDGET = 20_000;
const TIMEOUT_MARGIN = 5_000;
const DEFAULT_MAX_TIMEOUT = 120_000;
const STEP_REFERENCE = 20;

const clampNumber = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

interface TimeoutOptions {
  multiplier?: number;
  minMs?: number;
  maxMs?: number;
}

// 根据输出分辨率与步数动态计算请求超时时间，兼顾高分辨率与低配置场景。
const computeDynamicTimeout = (steps: number, width: number, height: number, options: TimeoutOptions = {}): number => {
  if (
    !Number.isFinite(steps) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    steps <= 0 ||
    width <= 0 ||
    height <= 0
  ) {
    return Math.max(DEFAULT_TIMEOUT, BASE_TIMEOUT_BUDGET);
  }
  const multiplier = Number.isFinite(options.multiplier) ? clampNumber(options.multiplier ?? 1, 0.25, 10) : 1;
  const maxMsCandidate = Number.isFinite(options.maxMs) ? Math.max(BASE_TIMEOUT_BUDGET, options.maxMs ?? DEFAULT_MAX_TIMEOUT) : DEFAULT_MAX_TIMEOUT;
  const minMs = Number.isFinite(options.minMs)
    ? clampNumber(options.minMs ?? BASE_TIMEOUT_BUDGET, 5_000, maxMsCandidate)
    : BASE_TIMEOUT_BUDGET;
  const maxMs = Math.max(minMs, maxMsCandidate);
  const areaScale = Math.max(1, (width * height) / BASE_RESOLUTION);
  const stepScale = clampNumber(steps / STEP_REFERENCE, 0.5, 5);
  const budget = (BASE_TIMEOUT_BUDGET + TIMEOUT_MARGIN) * areaScale * stepScale * multiplier;
  return Math.round(clampNumber(budget, minMs, maxMs));
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

const extractOptionList = (payload: unknown, keys: string[]): unknown[] | null => {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return null;
  const objectPayload = payload as Record<string, unknown>;
  for (const key of keys) {
    if (Array.isArray(objectPayload[key])) {
      return objectPayload[key] as unknown[];
    }
  }
  return null;
};

export const normalizeOptions = (collection: unknown, labelKeys: string[], valueKey?: string): SdOption[] => {
  if (!Array.isArray(collection)) return [];
  return collection
    .map((item) => {
      if (typeof item === "string") {
        const value = item.trim();
        return value ? toOption(value, value, item) : null;
      }
      if (!item || typeof item !== "object") return null;
      const objectItem = item as Record<string, unknown>;
      const base = extractLabel(objectItem, labelKeys);
      const label = base || (valueKey ? String(objectItem[valueKey] ?? "") : "");
      const value =
        valueKey && typeof objectItem[valueKey] === "string"
          ? (objectItem[valueKey] as string)
          : label;
      if (!label || !value) return null;
      return toOption(label, value, item);
    })
    .filter((item): item is SdOption => Boolean(item));
};

const extractOptionCollection = (payload: unknown, keys: string[]): unknown[] => {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  for (const key of keys) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  for (const value of Object.values(record)) {
    const nested = extractOptionCollection(value, keys);
    if (nested.length > 0) return nested;
  }
  return [];
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
      unit.image = params.controlNet.image;
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
  const controllers = new Map<string, AbortController>();
  const abortCauses = new WeakMap<AbortController, "cancelled" | "timeout">();
  let requestSequence = 0;
  const abortWithCause = (controller: AbortController, cause: "cancelled" | "timeout") => {
    if (abortCauses.has(controller) || controller.signal.aborted) return false;
    abortCauses.set(controller, cause);
    controller.abort();
    return true;
  };
  const toMilliseconds = (seconds: number | undefined, fallbackMs: number) => {
    if (!Number.isFinite(seconds)) return fallbackMs;
    return Math.max(0, Math.round((seconds as number) * 1000));
  };
  const minMs = Math.max(5_000, toMilliseconds(settings.timeoutMinSeconds, BASE_TIMEOUT_BUDGET));
  const maxMs = Math.max(minMs, toMilliseconds(settings.timeoutMaxSeconds, DEFAULT_MAX_TIMEOUT));
  const timeoutOptions: TimeoutOptions = {
    multiplier: clampNumber(settings.timeoutMultiplier ?? 1, 0.25, 10),
    minMs,
    maxMs
  };

  const makeUrl = (path: string) => {
    if (!baseURL) {
      throw new Error("PXD backend endpoint is not configured");
    }
    return `${baseURL}${path}`;
  };

  const fetchJson = async <T>(path: string, init: RequestOptions = {}) => {
    const {
      timeoutMs = DEFAULT_TIMEOUT,
      taskId,
      signal: externalSignal,
      ...requestInit
    } = init;
    const requestId = taskId ?? `pxd-request-${++requestSequence}`;
    const previousController = controllers.get(requestId);
    if (previousController) {
      abortWithCause(previousController, "cancelled");
    }

    const controller = new AbortController();
    controllers.set(requestId, controller);
    const abortFromExternal = () => abortWithCause(controller, "cancelled");
    if (externalSignal?.aborted) abortFromExternal();
    else externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
    const timeout = setTimeout(() => {
      if (controllers.get(requestId) === controller) {
        abortWithCause(controller, "timeout");
      }
    }, timeoutMs);
    const startedAt = Date.now();

    try {
      const response = await fetch(makeUrl(path), {
        ...requestInit,
        signal: controller.signal
      });
      if (controller.signal.aborted) {
        throw controller.signal.reason;
      }
      if (!response.ok) {
        const message = await response.text();
        const elapsed = Date.now() - startedAt;
        throw new Error(`Request failed (${response.status}) after ${elapsed}ms (timeout ${timeoutMs}ms): ${message}`);
      }
      const data = (await response.json()) as T;
      if (controller.signal.aborted) {
        throw controller.signal.reason;
      }
      return data;
    } catch (error) {
      if (controller.signal.aborted) {
        if (abortCauses.get(controller) === "timeout") {
          throw new PxdRequestTimeoutError(timeoutMs, taskId);
        }
        throw new PxdRequestCancelledError(taskId);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", abortFromExternal);
      if (controllers.get(requestId) === controller) {
        controllers.delete(requestId);
      }
    }
  };

  const cancel = (taskId: string) => {
    const controller = controllers.get(taskId);
    if (!controller) return false;
    abortWithCause(controller, "cancelled");
    return true;
  };

  const cancelAll = () => {
    const activeControllers = [...controllers.values()];
    for (const controller of activeControllers) {
      abortWithCause(controller, "cancelled");
    }
    return activeControllers.length;
  };

  const fetchFirstOptionCollection = async (paths: string[], responseKeys: string[]) => {
    for (const path of paths) {
      const payload = await fetchJson<unknown>(path).catch((error) => {
        rethrowCancellation(error);
        return null;
      });
      const collection = extractOptionCollection(payload, responseKeys);
      if (collection.length > 0) return collection;
    }
    return [];
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
        rethrowCancellation(error);
        console.warn("Failed to fetch models", error);
        return [];
      });
      const vaePromise = (async () => {
        const viaModules = await fetchJson<unknown[]>("/sdapi/v1/sd-modules").catch((error) => {
          rethrowCancellation(error);
          return null;
        });
        if (viaModules && Array.isArray(viaModules)) return viaModules;
        return await fetchJson<unknown[]>("/sdapi/v1/sd-vae").catch((error) => {
          rethrowCancellation(error);
          console.warn("Failed to fetch VAE list", error);
          return [];
        });
      })();
      const loraPromise = fetchJson<unknown[]>("/sdapi/v1/loras").catch((error) => {
        rethrowCancellation(error);
        console.warn("Failed to fetch loras", error);
        return [];
      });
      const samplerPromise = fetchJson<unknown[]>("/sdapi/v1/samplers").catch((error) => {
        rethrowCancellation(error);
        console.warn("Failed to fetch samplers", error);
        return [];
      });
      const schedulerPromise = fetchJson<unknown[]>("/sdapi/v1/schedulers").catch((error) => {
        rethrowCancellation(error);
        console.warn("Failed to fetch schedulers", error);
        return [];
      });
      const controlNetModelsPromise = fetchFirstOptionCollection(
        [
          "/controlnet/model_list",
          "/sdapi/v1/controlnet/model_list",
          "/controlnet/models",
          "/sdapi/v1/controlnet/models",
          "/controlnet/control_types"
        ],
        ["model_list", "models"]
      );
      const controlNetModulesPromise = fetchFirstOptionCollection(
        [
          "/controlnet/module_list?alias_names=true",
          "/sdapi/v1/controlnet/module_list?alias_names=true",
          "/controlnet/modules",
          "/sdapi/v1/controlnet/modules",
          "/controlnet/control_types"
        ],
        ["module_list", "modules"]
      );

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
    async txt2img(params: Txt2ImgParams, options: RequestTaskOptions = {}): Promise<Txt2ImgResponse> {
      const payload = buildTxt2ImgPayload({
        ...params,
        controlNet: params.controlNet
          ? {
              ...params.controlNet,
              image: params.controlNet.image ? dataUrlToBase64(params.controlNet.image) : undefined
            }
          : undefined
      });
      const timeoutMs = computeDynamicTimeout(params.steps, params.width, params.height, timeoutOptions);
      return await fetchJson<Txt2ImgResponse>("/sdapi/v1/txt2img", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        timeoutMs,
        ...options
      });
    },
    async img2img(params: Img2ImgParams, options: RequestTaskOptions = {}): Promise<Txt2ImgResponse> {
      const baseImage = dataUrlToBase64(params.baseImage);
      const timeoutMs = computeDynamicTimeout(params.steps, params.width, params.height, timeoutOptions);
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
        timeoutMs,
        ...options
      });
    },
    async fetchProgress(): Promise<ProgressResponse | null> {
      try {
        return await fetchJson<ProgressResponse>("/sdapi/v1/progress?skip_current_image=false", {
          method: "GET",
          timeoutMs: 5_000
        });
      } catch (error) {
        if (isPxdRequestCancelledError(error)) return null;
        console.warn("Progress polling failed", error);
        return null;
      }
    },
    cancel,
    cancelAll
  };
};
