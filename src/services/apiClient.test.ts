import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "./settings";
import {
  createPxdClient,
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
    let finishParsing: (() => void) | undefined;
    const json = vi.fn(() => new Promise<{ images: string[] }>((resolve) => {
      finishParsing = () => resolve({ images: ["late"] });
    }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json } as unknown as Response));
    const client = createPxdClient(settings);
    const pending = client.img2img(params, { taskId: "parsing" });
    const assertion = expect(pending).rejects.toBeInstanceOf(PxdRequestCancelledError);
    await vi.waitFor(() => expect(json).toHaveBeenCalledOnce());

    expect(client.cancel("parsing")).toBe(true);
    finishParsing?.();
    await assertion;
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
