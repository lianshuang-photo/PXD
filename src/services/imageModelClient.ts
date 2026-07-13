import type { AppSettings } from "../context/types";

export interface EditImageParams {
  prompt: string;
  baseImageBase64: string;
  refImagesBase64?: string[];
  aspectRatio?: string;
  timeoutMs: number;
  taskId?: string;
  signal?: AbortSignal;
}

export interface ImageModelClient {
  editImage(params: EditImageParams): Promise<string>;
  cancel(taskId: string): boolean;
  cancelAll(): number;
}

export class ImageModelError extends Error {
  readonly code: string;
  readonly solution: string;
  readonly status?: number;

  constructor(message: string, code: string, solution: string, status?: number) {
    super(message);
    this.name = "ImageModelError";
    this.code = code;
    this.solution = solution;
    this.status = status;
  }
}

export const isImageModelCancelledError = (error: unknown): error is ImageModelError =>
  error instanceof ImageModelError && error.code === "CANCELLED";

interface GeminiPart {
  text?: string;
  inlineData?: { data?: string };
  inline_data?: { data?: string };
}

interface GeminiResponse {
  promptFeedback?: { blockReason?: string; blockReasonMessage?: string };
  candidates?: Array<{
    finishReason?: string;
    finishMessage?: string;
    content?: { parts?: GeminiPart[] };
  }>;
}

const MAX_FALLBACK_IMAGE_BYTES = 20 * 1024 * 1024;
const SUPPORTED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/bmp",
  "image/tiff"
]);

const sanitizeEndpoint = (value: string) => value.trim().replace(/\/+$/, "");
const sanitizeModel = (value: string) => value.trim().replace(/^models\//, "");
const stripDataUrl = (value: string) => value.replace(/^data:image\/[^;]+;base64,/i, "").replace(/\s/g, "");

const ensureConfigured = (settings: AppSettings) => {
  if (settings.offlineMode) {
    throw new ImageModelError(
      "离线模式下不能调用 Gemini 图像模型",
      "OFFLINE_MODE",
      "请在设置中关闭离线模式后再生成；选区图片只会在关闭后发送到所配置的服务。"
    );
  }
  if (!settings.geminiEndpoint.trim()) {
    throw new ImageModelError("未配置 Gemini 服务地址", "CONFIG_ENDPOINT", "请在设置中填写 Gemini Endpoint。");
  }
  if (!settings.geminiApiKey.trim()) {
    throw new ImageModelError("未配置 Gemini API Key", "CONFIG_API_KEY", "请在设置中填写有效的 API Key。");
  }
  if (!settings.geminiModel.trim()) {
    throw new ImageModelError("未配置 Gemini 模型", "CONFIG_MODEL", "请在设置中填写支持图像编辑的模型名称。");
  }
};

const httpErrorDetails = (status: number): { code: string; message: string; solution: string } => {
  if (status === 400) {
    return { code: "HTTP_400", message: "图像模型请求参数不正确", solution: "请检查模型名称、提示词和图片数据后重试。" };
  }
  if (status === 401) {
    return { code: "HTTP_401", message: "图像模型鉴权失败", solution: "请检查 API Key 与鉴权模式是否匹配。" };
  }
  if (status === 403) {
    return { code: "HTTP_403", message: "图像模型拒绝访问", solution: "请确认 API Key 有权访问该模型，并检查服务区域或配额限制。" };
  }
  if (status === 422) {
    return { code: "HTTP_422", message: "图像模型无法处理当前内容", solution: "请调整提示词或更换输入图片后重试。" };
  }
  if (status === 429) {
    return { code: "HTTP_429", message: "图像模型请求过于频繁或配额不足", solution: "请稍后重试，或检查账号配额。" };
  }
  if (status >= 500) {
    return { code: "HTTP_5XX", message: "图像模型服务暂时不可用", solution: "请稍后重试；持续失败时检查 Endpoint 或中转服务状态。" };
  }
  return { code: `HTTP_${status}`, message: `图像模型请求失败（HTTP ${status}）`, solution: "请检查服务地址与模型配置后重试。" };
};

const arrayBufferToBase64 = (buffer: ArrayBuffer) => {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
};

const parseIpv4 = (hostname: string) => {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) return null;
  const octets = parts.map(Number);
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null;
};

const isBlockedIpv4 = ([a, b]: number[]) =>
  a === 0 ||
  a === 10 ||
  a === 127 ||
  (a === 100 && b >= 64 && b <= 127) ||
  (a === 169 && b === 254) ||
  (a === 172 && b >= 16 && b <= 31) ||
  (a === 192 && (b === 0 || b === 168)) ||
  (a === 198 && (b === 18 || b === 19)) ||
  a >= 224;

const parseIpv6 = (hostname: string) => {
  let input = hostname;
  const dottedTail = input.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dottedTail) {
    const ipv4 = parseIpv4(dottedTail);
    if (!ipv4) return null;
    input = input.slice(0, -dottedTail.length) +
      `${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
  }
  const halves = input.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const omitted = 8 - left.length - right.length;
  if (omitted < (halves.length === 2 ? 1 : 0)) return null;
  const groups = [...left, ...Array(omitted).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[a-f0-9]{1,4}$/i.test(group))) return null;
  return groups.map((group) => Number.parseInt(group, 16));
};

const isBlockedIpv6 = (groups: number[]) => {
  const allZeroPrefix = groups.slice(0, 6).every((group) => group === 0);
  const embeddedIpv4 = [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff];
  return (
    groups.every((group) => group === 0) ||
    (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) ||
    (groups[0] & 0xfe00) === 0xfc00 ||
    (groups[0] & 0xffc0) === 0xfe80 ||
    (groups[0] & 0xffc0) === 0xfec0 ||
    (groups[0] & 0xff00) === 0xff00 ||
    (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff && isBlockedIpv4(embeddedIpv4)) ||
    (allZeroPrefix && isBlockedIpv4(embeddedIpv4))
  );
};

const isBlockedHostname = (hostname: string) => {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!normalized || normalized === "localhost" || normalized.endsWith(".localhost")) return true;
  if (
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal") ||
    normalized.endsWith(".lan") ||
    normalized.endsWith(".home") ||
    normalized.endsWith(".home.arpa")
  ) return true;

  const ipv4 = parseIpv4(normalized);
  if (ipv4) return isBlockedIpv4(ipv4);
  if (normalized.includes(":")) {
    const ipv6 = parseIpv6(normalized);
    return ipv6 ? isBlockedIpv6(ipv6) : true;
  }
  return !normalized.includes(".");
};

const effectivePort = (url: URL) => url.port || (url.protocol === "https:" ? "443" : "80");

const validatePublicImageUrl = (value: string, trustedEndpoint: string) => {
  let url: URL;
  let endpoint: URL;
  try {
    url = new URL(value);
    endpoint = new URL(trustedEndpoint);
  } catch {
    throw new ImageModelError("模型返回了无效的图片地址", "RESPONSE_IMAGE_URL", "请检查中转服务的响应格式。");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new ImageModelError("模型返回了不安全的图片地址", "RESPONSE_IMAGE_URL", "仅支持不含凭据的 HTTPS 图片地址。");
  }
  if (isBlockedHostname(url.hostname)) {
    throw new ImageModelError(
      "模型返回的图片地址指向本地或私有网络",
      "RESPONSE_IMAGE_PRIVATE_URL",
      "请让服务以内联图片数据返回结果，或使用可公开访问的图片地址。"
    );
  }
  if (
    url.hostname.toLowerCase() !== endpoint.hostname.toLowerCase() ||
    effectivePort(url) !== effectivePort(endpoint)
  ) {
    throw new ImageModelError(
      "模型返回的图片地址不属于已信任的服务",
      "RESPONSE_IMAGE_UNTRUSTED_ORIGIN",
      "仅允许从所配置 Gemini Endpoint 的同域名、同端口下载图片；请让服务改为返回 inlineData。"
    );
  }
  return url.toString();
};

const readLimitedResponseBody = async (response: Response) => {
  const reader = response.body?.getReader?.();
  if (!reader) {
    throw new ImageModelError(
      "当前环境不支持安全的流式图片下载",
      "RESPONSE_IMAGE_STREAM_REQUIRED",
      "请让 Gemini Endpoint 直接返回 inlineData；为避免无界内存占用，不会使用 arrayBuffer 读取 URL。"
    );
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_FALLBACK_IMAGE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new ImageModelError("模型返回的图片过大", "RESPONSE_IMAGE_TOO_LARGE", "请让服务返回 20 MB 以内的图片。");
    }
    chunks.push(value);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output.buffer;
};

const extractEmbeddedBase64 = (text: string) => {
  const match = text.match(/data:image\/[a-z0-9.+-]+;base64,([a-z0-9+/=\s]+)/i);
  return match?.[1] ? stripDataUrl(match[1]) : null;
};

const extractImageUrl = (text: string) => {
  const markdown = text.match(/!\[[^\]]*]\((https?:\/\/[^\s)]+)\)/i);
  if (markdown?.[1]) return markdown[1];
  const plain = text.match(/https?:\/\/[^\s<>"']+/i)?.[0];
  return plain?.replace(/[),.;]+$/, "") ?? null;
};

const safetyReasonLabel = (reason: string) => {
  const labels: Record<string, string> = {
    SAFETY: "安全策略",
    BLOCKLIST: "受限内容",
    PROHIBITED_CONTENT: "禁止内容",
    IMAGE_SAFETY: "图片安全策略",
    OTHER: "其他安全策略"
  };
  return labels[reason.toUpperCase()] ?? "安全策略";
};

const downloadImageAsBase64 = async (url: string, signal: AbortSignal, trustedEndpoint: string) => {
  const safeUrl = validatePublicImageUrl(url, trustedEndpoint);
  const response = await fetch(safeUrl, { method: "GET", signal, redirect: "error" });
  if (!response.ok) {
    throw new ImageModelError(
      `模型返回的图片下载失败（HTTP ${response.status}）`,
      "RESPONSE_IMAGE_DOWNLOAD",
      "请重试；持续失败时检查中转服务是否返回了可公开访问的图片地址。",
      response.status
    );
  }
  const contentType = (response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
  if (!SUPPORTED_IMAGE_TYPES.has(contentType)) {
    throw new ImageModelError("模型返回的地址不是受支持的图片", "RESPONSE_IMAGE_TYPE", "请让图片服务返回有效的 PNG、JPEG、WebP、GIF、BMP 或 TIFF Content-Type。");
  }
  const contentLengthHeader = response.headers.get("content-length");
  const contentLength = contentLengthHeader && /^\d+$/.test(contentLengthHeader)
    ? Number(contentLengthHeader)
    : null;
  if (contentLength !== null && (!Number.isSafeInteger(contentLength) || contentLength > MAX_FALLBACK_IMAGE_BYTES)) {
    throw new ImageModelError("模型返回的图片过大", "RESPONSE_IMAGE_TOO_LARGE", "请让服务返回 20 MB 以内的图片。");
  }
  return arrayBufferToBase64(await readLimitedResponseBody(response));
};

const parseImage = async (data: GeminiResponse, signal: AbortSignal, trustedEndpoint: string): Promise<string> => {
  const blockReason = data.promptFeedback?.blockReason;
  if (blockReason) {
    throw new ImageModelError(
      `输入内容触发安全审查（${safetyReasonLabel(blockReason)}）`,
      "SAFETY_INPUT",
      "请移除可能涉及敏感、侵权或不安全内容的描述与图片后重试。"
    );
  }

  const candidate = data.candidates?.[0];
  const finishReason = candidate?.finishReason?.toUpperCase();
  if (finishReason === "SAFETY" || finishReason === "RECITATION") {
    const reason = finishReason === "SAFETY" ? "安全策略" : "疑似受版权保护内容";
    throw new ImageModelError(
      `输出内容被拦截（${reason}）`,
      `SAFETY_OUTPUT_${finishReason}`,
      "请调整提示词，避免敏感内容或要求复现特定作品后重试。"
    );
  }

  const parts = candidate?.content?.parts ?? [];
  for (const part of parts) {
    const inlineData = part.inlineData?.data ?? part.inline_data?.data;
    if (inlineData) return stripDataUrl(inlineData);
  }

  const text = parts.map((part) => part.text ?? "").filter(Boolean).join("\n");
  const embedded = extractEmbeddedBase64(text);
  if (embedded) return embedded;

  const imageUrl = extractImageUrl(text);
  if (imageUrl) return await downloadImageAsBase64(imageUrl, signal, trustedEndpoint);

  throw new ImageModelError(
    "图像模型未返回可用图片",
    "RESPONSE_NO_IMAGE",
    "请确认所选模型支持图片输出，并检查中转服务是否保留了 inlineData。"
  );
};

export const createImageModelClient = (settings: AppSettings): ImageModelClient => {
  const controllers = new Map<string, AbortController>();
  let requestSequence = 0;

  const cancel = (taskId: string) => {
    const controller = controllers.get(taskId);
    if (!controller) return false;
    controller.abort();
    return true;
  };

  const cancelAll = () => {
    const activeControllers = [...controllers.values()];
    for (const controller of activeControllers) {
      controller.abort();
    }
    return activeControllers.length;
  };

  return {
    async editImage(params) {
    ensureConfigured(settings);
    if (!params.prompt.trim()) {
      throw new ImageModelError("请输入图像编辑指令", "CONFIG_PROMPT", "请填写提示词后重试。");
    }
    if (!params.baseImageBase64.trim()) {
      throw new ImageModelError("未收到选区图片", "CONFIG_IMAGE", "请重新选择 Photoshop 区域后重试。");
    }

    const endpoint = sanitizeEndpoint(settings.geminiEndpoint);
    const model = encodeURIComponent(sanitizeModel(settings.geminiModel));
    const key = settings.geminiApiKey.trim();
    const baseUrl = `${endpoint}/v1beta/models/${model}:generateContent`;
    const url = settings.geminiAuthMode === "queryKey" ? `${baseUrl}?key=${encodeURIComponent(key)}` : baseUrl;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (settings.geminiAuthMode === "bearer") headers.Authorization = `Bearer ${key}`;

    const imageParts = [params.baseImageBase64, ...(params.refImagesBase64 ?? [])].map((data) => ({
      inlineData: { mimeType: "image/png", data: stripDataUrl(data) }
    }));
    const aspectRatio = params.aspectRatio?.trim();
    const body = {
      contents: [{ role: "user", parts: [{ text: params.prompt }, ...imageParts] }],
      generationConfig: {
        responseModalities: ["IMAGE", "TEXT"],
        temperature: 0.8,
        topP: 0.95,
        maxOutputTokens: 8192,
        ...(aspectRatio && aspectRatio.toLowerCase() !== "auto" ? { imageConfig: { aspectRatio } } : {})
      }
    };

    const requestId = params.taskId ?? `image-model-request-${++requestSequence}`;
    const previousController = controllers.get(requestId);
    if (previousController) {
      previousController.abort();
    }
    const controller = new AbortController();
    controllers.set(requestId, controller);
    let timedOut = false;
    const timeoutMs = Number.isFinite(params.timeoutMs) && params.timeoutMs > 0 ? params.timeoutMs : 120_000;
    const abortFromExternal = () => controller.abort(params.signal?.reason);
    if (params.signal?.aborted) abortFromExternal();
    else params.signal?.addEventListener("abort", abortFromExternal, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      });
      if (controller.signal.aborted) {
        throw controller.signal.reason;
      }
      if (!response.ok) {
        const detail = httpErrorDetails(response.status);
        throw new ImageModelError(detail.message, detail.code, detail.solution, response.status);
      }
      let data: GeminiResponse;
      try {
        data = (await response.json()) as GeminiResponse;
      } catch {
        throw new ImageModelError(
          "图像模型返回了无法解析的响应",
          "RESPONSE_INVALID",
          "请确认 Endpoint 指向 Gemini generateContent 兼容服务。"
        );
      }
      if (controller.signal.aborted) {
        throw controller.signal.reason;
      }
      return await parseImage(data, controller.signal, settings.geminiEndpoint);
    } catch (error) {
      if (controller.signal.aborted) {
        if (timedOut) {
          throw new ImageModelError(`图像生成超时（${Math.max(1, Math.ceil(timeoutMs / 1000))} 秒）`, "TIMEOUT", "请稍后重试，或在设置中增大最长超时。");
        }
        throw new ImageModelError("图像生成已取消", "CANCELLED", "可重新发起生成任务。");
      }
      if (error instanceof ImageModelError) throw error;
      throw new ImageModelError(
        "无法连接图像模型服务",
        "NETWORK",
        "请检查网络、Endpoint 和 UXP 网络权限后重试。"
      );
    } finally {
      clearTimeout(timeout);
      params.signal?.removeEventListener("abort", abortFromExternal);
      if (controllers.get(requestId) === controller) {
        controllers.delete(requestId);
      }
    }
    },
    cancel,
    cancelAll
  };
};
