import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "./settings";
import {
  createPxdClient,
  normalizeOptions,
  PxdRequestCancelledError,
  PxdRequestTimeoutError,
  type Img2ImgParams
} from "./apiClient";

const settings = {
  ...DEFAULT_SETTINGS,
  sdEndpoint: "http://127.0.0.1:7860",
  timeoutMinSeconds: 5,
  timeoutMaxSeconds: 5,
  timeoutMultiplier: 1
};

const params: Img2ImgParams = {
  prompt: "edit",
  steps: 1,
  cfgScale: 7,
  batchSize: 1,
  width: 64,
  height: 64,
  denoisingStrength: 0.4,
  baseImage: "data:image/png;base64,BASE"
};

const createAbortingFetch = () => vi.fn((_url: string, init: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    const rejectAbort = () => reject(new DOMException("aborted", "AbortError"));
    if (init.signal?.aborted) rejectAbort();
    else init.signal?.addEventListener("abort", rejectAbort, { once: true });
  })
);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("createPxdClient cancellation", () => {
  it("cancels a Forge request by task ID and exposes a recognizable error", async () => {
    const fetchMock = createAbortingFetch();
    vi.stubGlobal("fetch", fetchMock);
    const client = createPxdClient(settings);

    const pending = client.img2img(params, { taskId: "forge-one" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    expect(client.cancel("forge-one")).toBe(true);
    await expect(pending).rejects.toMatchObject({
      name: PxdRequestCancelledError.name,
      code: "CANCELLED",
      taskId: "forge-one"
    });
    expect(client.cancel("forge-one")).toBe(false);
  });

  it("cancels every active Forge request", async () => {
    const fetchMock = createAbortingFetch();
    vi.stubGlobal("fetch", fetchMock);
    const client = createPxdClient(settings);
    const first = client.img2img(params, { taskId: "first" });
    const second = client.img2img(params, { taskId: "second" });
    const firstAssertion = expect(first).rejects.toBeInstanceOf(PxdRequestCancelledError);
    const secondAssertion = expect(second).rejects.toBeInstanceOf(PxdRequestCancelledError);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect(client.cancelAll()).toBe(2);
    await Promise.all([firstAssertion, secondAssertion]);
    expect(client.cancelAll()).toBe(0);
  });

  it("aborts the underlying fetch when the dynamic timeout expires", async () => {
    vi.useFakeTimers();
    const fetchMock = createAbortingFetch();
    vi.stubGlobal("fetch", fetchMock);
    const client = createPxdClient(settings);

    const pending = client.img2img(params, { taskId: "slow" });
    const assertion = expect(pending).rejects.toMatchObject({
      name: PxdRequestTimeoutError.name,
      code: "TIMEOUT",
      timeoutMs: 12_500,
      taskId: "slow"
    });
    await vi.advanceTimersByTimeAsync(12_500);
    await assertion;
    const init = fetchMock.mock.calls[0][1];
    expect(init.signal?.aborted).toBe(true);
  });

  it("does not leave a completed request registered", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ images: ["done"] }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })));
    const client = createPxdClient(settings);

    await expect(client.img2img(params, { taskId: "complete" })).resolves.toMatchObject({ images: ["done"] });
    expect(client.cancel("complete")).toBe(false);
  });

  it("honors cancellation while a successful Forge response is still parsing", async () => {
    vi.useFakeTimers();
    let finishParsing: (() => void) | undefined;
    const json = vi.fn(() => new Promise<{ images: string[] }>((resolve) => {
      finishParsing = () => resolve({ images: ["late"] });
    }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json } as unknown as Response));
    const client = createPxdClient(settings);
    const pending = client.img2img(params, { taskId: "parsing" });
    const result = pending.catch((error) => error);
    await Promise.resolve();
    await Promise.resolve();
    expect(json).toHaveBeenCalledOnce();

    expect(client.cancel("parsing")).toBe(true);
    await vi.advanceTimersByTimeAsync(12_500);
    finishParsing?.();
    expect(await result).toBeInstanceOf(PxdRequestCancelledError);
  });

  it("stops option fallbacks immediately when all requests are cancelled", async () => {
    const fetchMock = createAbortingFetch();
    vi.stubGlobal("fetch", fetchMock);
    const client = createPxdClient(settings);
    const pending = client.fetchOptions();
    const assertion = expect(pending).rejects.toBeInstanceOf(PxdRequestCancelledError);
    await vi.waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(7));

    expect(client.cancelAll()).toBeGreaterThanOrEqual(7);
    await assertion;
    const requestedPaths = fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname);
    expect(requestedPaths).not.toContain("/sdapi/v1/sd-vae");
    expect(requestedPaths).not.toContain("/controlnet/models");
  });

  it("does not let an older request remove a replacement with the same task ID", async () => {
    const fetchMock = createAbortingFetch();
    vi.stubGlobal("fetch", fetchMock);
    const client = createPxdClient(settings);
    const first = client.img2img(params, { taskId: "reused" });
    const firstAssertion = expect(first).rejects.toBeInstanceOf(PxdRequestCancelledError);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    const replacement = client.img2img(params, { taskId: "reused" });
    const replacementAssertion = expect(replacement).rejects.toBeInstanceOf(PxdRequestCancelledError);
    await firstAssertion;
    expect(client.cancel("reused")).toBe(true);
    await replacementAssertion;
  });
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
