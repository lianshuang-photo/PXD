import type { AppSettings } from "../context/types";
import {
  createPxdClient,
  type Img2ImgParams,
  type ProgressResponse,
  type SdOptions,
  type Txt2ImgParams
} from "./apiClient";
import { createImageModelClient, type ImageModelClient } from "./imageModelClient";

export interface EngineResult {
  images: string[];
}

export interface EngineGenerateParams {
  prompt: string;
  systemPrompt?: string;
  baseImageBase64: string;
  aspectRatio?: string;
  timeoutMs: number;
  forgeParams?: Img2ImgParams;
  forgeTxt2ImgParams?: Txt2ImgParams;
  taskId?: string;
  signal?: AbortSignal;
}

export type EngineProgressMode = "determinate" | "indeterminate";

export interface GenerationEngine {
  provider: AppSettings["imageProvider"];
  progressMode: EngineProgressMode;
  generate(params: EngineGenerateParams): Promise<EngineResult>;
  cancel(taskId: string): boolean;
  cancelAll(): number;
  fetchOptions?: () => Promise<SdOptions>;
  fetchProgress?: () => Promise<ProgressResponse | null>;
}

type ForgeClient = ReturnType<typeof createPxdClient>;

export interface GenerationEngineFactories {
  createForgeClient: (settings: AppSettings) => ForgeClient;
  createGeminiClient: (settings: AppSettings) => ImageModelClient;
}

export const DEFAULT_GENERATION_ENGINE_FACTORIES: GenerationEngineFactories = {
  createForgeClient: createPxdClient,
  createGeminiClient: createImageModelClient
};

export class GenerationEngineError extends Error {
  readonly code: string;
  readonly solution: string;
  readonly provider: AppSettings["imageProvider"];
  readonly originalError: unknown;

  constructor(
    message: string,
    code: string,
    solution: string,
    provider: AppSettings["imageProvider"],
    originalError?: unknown
  ) {
    super(message);
    this.name = "GenerationEngineError";
    this.code = code;
    this.solution = solution;
    this.provider = provider;
    this.originalError = originalError;
  }
}

interface ActionableError extends Error {
  code: string;
  solution: string;
}

const isActionableError = (error: unknown): error is ActionableError =>
  error instanceof Error &&
  typeof (error as Partial<ActionableError>).code === "string" &&
  typeof (error as Partial<ActionableError>).solution === "string";

const toEngineError = (
  provider: AppSettings["imageProvider"],
  error: unknown
): GenerationEngineError => {
  if (error instanceof GenerationEngineError) return error;
  if (isActionableError(error)) {
    return new GenerationEngineError(error.message, error.code, error.solution, provider, error);
  }
  const message = error instanceof Error ? error.message : "图像生成失败";
  const label = provider === "forge" ? "Forge" : "Gemini";
  return new GenerationEngineError(
    message,
    provider === "forge" ? "FORGE_REQUEST_FAILED" : "GEMINI_REQUEST_FAILED",
    `请检查 ${label} 服务配置与网络连接后重试。`,
    provider,
    error
  );
};

export const formatGenerationError = (error: unknown, fallback: string) => {
  if (isActionableError(error)) {
    return `${error.message}；建议：${error.solution}`;
  }
  return error instanceof Error ? error.message : fallback;
};

export const createGenerationEngine = (
  settings: AppSettings,
  factories: GenerationEngineFactories = DEFAULT_GENERATION_ENGINE_FACTORIES
): GenerationEngine => {
  if (settings.imageProvider === "gemini") {
    const client = factories.createGeminiClient(settings);
    return {
      provider: "gemini",
      progressMode: "indeterminate",
      async generate(params) {
        try {
          const image = await client.editImage({
            prompt: params.prompt,
            systemPrompt: params.systemPrompt,
            baseImageBase64: params.baseImageBase64,
            aspectRatio: params.aspectRatio ?? "Auto",
            timeoutMs: params.timeoutMs,
            taskId: params.taskId,
            signal: params.signal
          });
          return { images: [image] };
        } catch (error) {
          throw toEngineError("gemini", error);
        }
      },
      cancel: (taskId) => client.cancel(taskId),
      cancelAll: () => client.cancelAll()
    };
  }

  const client = factories.createForgeClient(settings);
  return {
    provider: "forge",
    progressMode: "determinate",
    fetchOptions: () => client.fetchOptions(),
    fetchProgress: () => client.fetchProgress(),
    async generate(params) {
      try {
        if (params.forgeTxt2ImgParams) {
          const result = await client.txt2img(params.forgeTxt2ImgParams, {
            taskId: params.taskId,
            signal: params.signal
          });
          return { images: result.images ?? [] };
        }
        if (!params.forgeParams) {
          throw new GenerationEngineError(
            "Forge 生成参数不完整",
            "ENGINE_REQUEST_INVALID",
            "请重新获取选区并发起生成。",
            "forge"
          );
        }
        const result = await client.img2img(params.forgeParams, {
          taskId: params.taskId,
          signal: params.signal
        });
        return { images: result.images ?? [] };
      } catch (error) {
        throw toEngineError("forge", error);
      }
    },
    cancel: (taskId) => client.cancel(taskId),
    cancelAll: () => client.cancelAll()
  };
};
