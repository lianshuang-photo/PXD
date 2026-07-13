import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "./settings";
import { createImageModelClient, ImageModelError } from "./imageModelClient";

const settings = {
  ...DEFAULT_SETTINGS,
  imageProvider: "gemini" as const,
  geminiEndpoint: "https://example.test/root/",
  geminiApiKey: "secret key",
  geminiModel: "models/image-model"
};

const inlineResponse = (data = "OUTPUT_BASE64") =>
  new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: "done" }, { inlineData: { mimeType: "image/png", data } }] } }]
  }), { status: 200, headers: { "Content-Type": "application/json" } });

const editParams = {
  prompt: "change the light",
  baseImageBase64: "data:image/png;base64,BASE_IMAGE",
  timeoutMs: 1_000
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("createImageModelClient", () => {
  it("builds a query-key request and returns the first inline image", async () => {
    const fetchMock = vi.fn().mockResolvedValue(inlineResponse());
    vi.stubGlobal("fetch", fetchMock);

    const result = await createImageModelClient({ ...settings, geminiAuthMode: "queryKey" }).editImage(editParams);

    expect(result).toBe("OUTPUT_BASE64");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.test/root/v1beta/models/image-model:generateContent?key=secret%20key");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    const body = JSON.parse(String(init.body));
    expect(body.contents[0].parts).toEqual([
      { text: "change the light" },
      { inlineData: { mimeType: "image/png", data: "BASE_IMAGE" } }
    ]);
    expect(body.generationConfig).toEqual({
      responseModalities: ["IMAGE", "TEXT"],
      temperature: 0.8,
      topP: 0.95,
      maxOutputTokens: 8192
    });
  });

  it("uses bearer auth and appends references in order with an explicit aspect ratio", async () => {
    const fetchMock = vi.fn().mockResolvedValue(inlineResponse());
    vi.stubGlobal("fetch", fetchMock);

    await createImageModelClient({ ...settings, geminiAuthMode: "bearer" }).editImage({
      ...editParams,
      refImagesBase64: ["REF_ONE", "data:image/png;base64,REF_TWO"],
      aspectRatio: "16:9"
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain("?key=");
    expect(init.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer secret key"
    });
    const body = JSON.parse(String(init.body));
    expect(body.contents[0].parts.slice(1).map((part: { inlineData: { data: string } }) => part.inlineData.data))
      .toEqual(["BASE_IMAGE", "REF_ONE", "REF_TWO"]);
    expect(body.generationConfig.imageConfig).toEqual({ aspectRatio: "16:9" });
  });

  it.each([
    [{ promptFeedback: { blockReason: "PROHIBITED_CONTENT" } }, "SAFETY_INPUT", "输入内容触发安全审查"],
    [{ candidates: [{ finishReason: "SAFETY" }] }, "SAFETY_OUTPUT_SAFETY", "输出内容被拦截"],
    [{ candidates: [{ finishReason: "RECITATION" }] }, "SAFETY_OUTPUT_RECITATION", "输出内容被拦截"]
  ])("maps blocked responses to actionable Chinese errors", async (payload, code, message) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 })));

    const error = await createImageModelClient(settings).editImage(editParams).catch((caught) => caught);
    expect(error).toBeInstanceOf(ImageModelError);
    expect(error).toMatchObject({ code });
    expect(error.message).toContain(message);
    expect(error.solution).toBeTruthy();
  });

  it("falls back to an embedded base64 image in markdown text", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: "![result](data:image/png;base64,ZmFrZQ==)" }] } }]
    }), { status: 200 })));

    await expect(createImageModelClient(settings).editImage(editParams)).resolves.toBe("ZmFrZQ==");
  });

  it("downloads a returned image URL as base64", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: "![result](https://cdn.test/result.png)" }] } }]
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([102, 97, 107, 101]), {
        status: 200,
        headers: { "Content-Type": "image/png" }
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createImageModelClient(settings).editImage(editParams)).resolves.toBe("ZmFrZQ==");
    expect(fetchMock.mock.calls[1][0]).toBe("https://cdn.test/result.png");
  });

  it("reports an invalid success response without calling it a network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not-json", { status: 200 })));

    await expect(createImageModelClient(settings).editImage(editParams))
      .rejects.toMatchObject({ code: "RESPONSE_INVALID" });
  });

  it.each([
    [400, "HTTP_400"],
    [401, "HTTP_401"],
    [403, "HTTP_403"],
    [422, "HTTP_422"],
    [429, "HTTP_429"],
    [503, "HTTP_5XX"]
  ])("maps HTTP %s without exposing the raw response", async (status, code) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"secret":"raw"}', { status })));

    const error = await createImageModelClient(settings).editImage(editParams).catch((caught) => caught);
    expect(error).toMatchObject({ code, status });
    expect(error.message).not.toContain("raw");
    expect(error.solution).toBeTruthy();
  });

  it("aborts the fetch when the timeout expires", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })));

    const pending = createImageModelClient(settings).editImage({ ...editParams, timeoutMs: 50 });
    const assertion = expect(pending).rejects.toMatchObject({ code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
  });

  it("links an external abort signal", async () => {
    const external = new AbortController();
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })));

    const pending = createImageModelClient(settings).editImage({ ...editParams, signal: external.signal });
    external.abort();
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("reports missing browser configuration before sending a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(createImageModelClient({ ...settings, geminiApiKey: "" }).editImage(editParams))
      .rejects.toMatchObject({ code: "CONFIG_API_KEY" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
