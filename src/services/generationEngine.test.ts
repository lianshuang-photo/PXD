import { describe, expect, it, vi } from "vitest";
import type { AppSettings } from "../context/types";
import type { Img2ImgParams, SdOptions } from "./apiClient";
import { ImageModelError } from "./imageModelClient";
import { DEFAULT_SETTINGS } from "./settings";
import {
  createGenerationEngine,
  formatGenerationError,
  GenerationEngineError,
  type EngineGenerateParams,
  type GenerationEngineFactories
} from "./generationEngine";

const forgeSettings: AppSettings = { ...DEFAULT_SETTINGS, imageProvider: "forge" };
const geminiSettings: AppSettings = {
  ...DEFAULT_SETTINGS,
  imageProvider: "gemini",
  offlineMode: false,
  geminiApiKey: "key"
};

const forgeParams: Img2ImgParams = {
  prompt: "edit",
  steps: 20,
  cfgScale: 7,
  batchSize: 1,
  width: 512,
  height: 512,
  denoisingStrength: 0.4,
  baseImage: "data:image/png;base64,INPUT"
};

const request: EngineGenerateParams = {
  prompt: "edit",
  baseImageBase64: "INPUT",
  timeoutMs: 30_000,
  forgeParams
};

const emptyOptions: SdOptions = {
  models: [],
  vaes: [],
  loras: [],
  samplers: [],
  schedulers: [],
  controlNetModels: [],
  controlNetModules: []
};

const makeClients = () => {
  const forgeClient = {
    ping: vi.fn().mockResolvedValue(true),
    fetchOptions: vi.fn().mockResolvedValue(emptyOptions),
    txt2img: vi.fn(),
    img2img: vi.fn().mockResolvedValue({ images: ["FORGE_IMAGE"] }),
    fetchProgress: vi.fn().mockResolvedValue({ progress: 0.5, eta_relative: 2 })
  };
  const geminiClient = {
    editImage: vi.fn().mockResolvedValue("GEMINI_IMAGE")
  };
  const createForgeClient = vi.fn().mockReturnValue(forgeClient);
  const createGeminiClient = vi.fn().mockReturnValue(geminiClient);
  const factories = {
    createForgeClient,
    createGeminiClient
  } as unknown as GenerationEngineFactories;
  return { forgeClient, geminiClient, createForgeClient, createGeminiClient, factories };
};

describe("createGenerationEngine", () => {
  it("routes a single Forge task and exposes determinate progress", async () => {
    const clients = makeClients();
    const engine = createGenerationEngine(forgeSettings, clients.factories);

    await expect(engine.generate(request)).resolves.toEqual({ images: ["FORGE_IMAGE"] });
    await expect(engine.fetchOptions?.()).resolves.toBe(emptyOptions);
    await expect(engine.fetchProgress?.()).resolves.toMatchObject({ progress: 0.5 });
    expect(engine).toMatchObject({ provider: "forge", progressMode: "determinate" });
    expect(clients.createForgeClient).toHaveBeenCalledOnce();
    expect(clients.createGeminiClient).not.toHaveBeenCalled();
    expect(clients.forgeClient.img2img).toHaveBeenCalledWith(forgeParams, {
      taskId: undefined,
      signal: undefined
    });
  });

  it("routes a single Gemini task without progress or Forge construction", async () => {
    const clients = makeClients();
    const engine = createGenerationEngine(geminiSettings, clients.factories);

    await expect(engine.generate({ ...request, forgeParams: undefined })).resolves.toEqual({
      images: ["GEMINI_IMAGE"]
    });
    expect(engine).toMatchObject({ provider: "gemini", progressMode: "indeterminate" });
    expect(engine.fetchProgress).toBeUndefined();
    expect(engine.fetchOptions).toBeUndefined();
    expect(clients.createGeminiClient).toHaveBeenCalledOnce();
    expect(clients.createForgeClient).not.toHaveBeenCalled();
    expect(clients.geminiClient.editImage).toHaveBeenCalledWith({
      prompt: "edit",
      baseImageBase64: "INPUT",
      aspectRatio: "Auto",
      timeoutMs: 30_000,
      taskId: undefined,
      signal: undefined
    });
  });

  it("wraps Forge failures in the shared actionable error contract", async () => {
    const clients = makeClients();
    clients.forgeClient.img2img.mockRejectedValue(new Error("connection refused"));
    const engine = createGenerationEngine(forgeSettings, clients.factories);

    const error = await engine.generate(request).catch((caught) => caught);
    expect(error).toBeInstanceOf(GenerationEngineError);
    expect(error).toMatchObject({
      provider: "forge",
      code: "FORGE_REQUEST_FAILED",
      message: "connection refused"
    });
    expect(error.solution).toContain("Forge");
    expect(formatGenerationError(error, "fallback")).toContain("建议：");
  });

  it("preserves Gemini error codes and solutions in the shared contract", async () => {
    const clients = makeClients();
    clients.geminiClient.editImage.mockRejectedValue(
      new ImageModelError("输出被拦截", "SAFETY_OUTPUT", "请调整提示词")
    );
    const engine = createGenerationEngine(geminiSettings, clients.factories);

    const error = await engine.generate({ ...request, forgeParams: undefined }).catch((caught) => caught);
    expect(error).toBeInstanceOf(GenerationEngineError);
    expect(error).toMatchObject({
      provider: "gemini",
      code: "SAFETY_OUTPUT",
      solution: "请调整提示词"
    });
    expect(formatGenerationError(error, "fallback")).toBe("输出被拦截；建议：请调整提示词");
  });

  it("rejects incomplete Forge requests with an actionable configuration error", async () => {
    const clients = makeClients();
    const engine = createGenerationEngine(forgeSettings, clients.factories);

    await expect(engine.generate({ ...request, forgeParams: undefined })).rejects.toMatchObject({
      code: "ENGINE_REQUEST_INVALID",
      provider: "forge"
    });
    expect(clients.forgeClient.img2img).not.toHaveBeenCalled();
  });
});
