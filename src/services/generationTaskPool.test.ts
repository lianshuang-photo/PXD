import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GenerationTaskPool,
  type GenerationTaskDefinition
} from "./generationTaskPool";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((candidateResolve, candidateReject) => {
    resolve = candidateResolve;
    reject = candidateReject;
  });
  return { promise, resolve, reject };
};

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const task = (
  id: string,
  run: GenerationTaskDefinition["run"],
  overrides: Partial<GenerationTaskDefinition> = {}
): GenerationTaskDefinition => ({
  id,
  title: id,
  engine: "forge",
  timeoutSeconds: 30,
  run,
  returnImages: vi.fn().mockResolvedValue(undefined),
  ...overrides
});

describe("GenerationTaskPool", () => {
  let pool: GenerationTaskPool;

  beforeEach(() => {
    vi.useFakeTimers();
    pool = new GenerationTaskPool({ concurrency: 2, tickMs: 1_000 });
  });

  afterEach(async () => {
    await pool.dispose();
    vi.useRealTimers();
  });

  it("limits network concurrency and releases a slot before Photoshop return", async () => {
    const first = deferred<string[]>();
    const second = deferred<string[]>();
    const third = deferred<string[]>();
    const blockedReturn = deferred<void>();
    const started: string[] = [];

    const completions = [pool.enqueue(task("one", async () => {
      started.push("one");
      return await first.promise;
    }, { returnImages: () => blockedReturn.promise })), pool.enqueue(task("two", async () => {
      started.push("two");
      return await second.promise;
    })), pool.enqueue(task("three", async () => {
      started.push("three");
      return await third.promise;
    }))];
    await flush();

    expect(started).toEqual(["one", "two"]);
    first.resolve(["ONE"]);
    await flush();
    expect(started).toEqual(["one", "two", "three"]);
    expect(pool.getSnapshot().one.status).toBe("returning");

    second.resolve(["TWO"]);
    third.resolve(["THREE"]);
    blockedReturn.resolve();
    await Promise.all(completions);
    expect(Object.values(pool.getSnapshot()).every(({ status }) => status === "success")).toBe(true);
  });

  it("serializes complete return workflows even when network work finishes together", async () => {
    const firstReturn = deferred<void>();
    const events: string[] = [];
    const firstCompletion = pool.enqueue(task("one", async () => ["ONE"], {
      returnImages: async () => {
        events.push("one:start");
        await firstReturn.promise;
        events.push("one:end");
      }
    }));
    const secondCompletion = pool.enqueue(task("two", async () => ["TWO"], {
      returnImages: async () => {
        events.push("two:start");
        await Promise.resolve();
        events.push("two:end");
      }
    }));
    await flush();

    expect(events).toEqual(["one:start"]);
    firstReturn.resolve();
    await Promise.all([firstCompletion, secondCompletion]);
    expect(events).toEqual(["one:start", "one:end", "two:start", "two:end"]);
  });

  it("releases network capacity before a slow best-effort result callback finishes", async () => {
    pool.setConcurrency(1);
    const history = deferred<void>();
    const next = deferred<string[]>();
    const started: string[] = [];
    const firstCompletion = pool.enqueue(task("one", async () => {
      started.push("one");
      return ["ONE"];
    }, { onResult: () => history.promise }));
    const secondCompletion = pool.enqueue(task("two", async () => {
      started.push("two");
      return next.promise;
    }));
    await flush();

    expect(started).toEqual(["one", "two"]);
    expect(pool.activeCount).toBe(1);
    history.resolve();
    next.resolve(["TWO"]);
    await Promise.all([firstCompletion, secondCompletion]);
  });

  it("keeps a successful task successful when its best-effort result callback fails", async () => {
    const completion = pool.enqueue(task("history-failure", async () => ["IMAGE"], {
      onResult: vi.fn().mockRejectedValue(new Error("history failed"))
    }));

    expect((await completion).status).toBe("success");
    expect(pool.getSnapshot()["history-failure"]).toMatchObject({
      status: "success",
      images: ["IMAGE"],
      error: undefined
    });
  });

  it("blocks return retry while cleanup is dirty and re-enables it after explicit cleanup", async () => {
    const cleanup = vi.fn()
      .mockRejectedValueOnce(new Error("circuit open"))
      .mockRejectedValueOnce(new Error("still open"))
      .mockResolvedValueOnce(undefined);
    const returnImages = vi.fn()
      .mockRejectedValueOnce(new Error("place failed"))
      .mockResolvedValueOnce(undefined);
    const run = vi.fn().mockResolvedValue(["IMAGE"]);
    const first = await pool.enqueue(task("dirty", run, { cleanup, returnImages }));

    expect(first.status).toBe("error");
    expect(pool.getSnapshot().dirty.cleanupPending).toBe(true);
    expect((await pool.retry("dirty"))?.cleanupPending).toBe(true);
    expect(returnImages).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);

    expect((await pool.cleanup("dirty"))?.cleanupPending).toBe(true);
    expect((await pool.cleanup("dirty"))?.cleanupPending).toBe(false);
    expect((await pool.retry("dirty"))?.status).toBe("success");
    expect(returnImages).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledTimes(1);
    expect(pool.activeCount).toBe(0);
  });

  it("coalesces concurrent retries into one network run and shared settlement", async () => {
    const retried = deferred<string[]>();
    const run = vi.fn()
      .mockRejectedValueOnce(new Error("network failed"))
      .mockImplementationOnce(() => retried.promise);
    expect((await pool.enqueue(task("coalesced", run))).status).toBe("error");

    const firstRetry = pool.retry("coalesced");
    const secondRetry = pool.retry("coalesced");
    await flush();
    await flush();
    expect(run).toHaveBeenCalledTimes(2);
    expect(pool.activeCount).toBe(1);

    retried.resolve(["RECOVERED"]);
    const [first, second] = await Promise.all([firstRetry, secondRetry]);
    expect(first).toMatchObject({ status: "success", attempt: 2 });
    expect(second).toEqual(first);
    expect(run).toHaveBeenCalledTimes(2);
    expect(pool.activeCount).toBe(0);
  });

  it("keeps a cancelled task dirty when a late rollback fails", async () => {
    const returnStarted = deferred<void>();
    const releaseReturn = deferred<void>();
    const cleanupRegistered = deferred<void>();
    const finishReturn = deferred<void>();
    const cleanup = vi.fn()
      .mockRejectedValueOnce(new Error("rollback still locked"))
      .mockResolvedValue(undefined);
    const completion = pool.enqueue(task("late-rollback", async () => ["IMAGE"], {
      cleanup,
      returnImages: async (_images, context) => {
        returnStarted.resolve();
        await releaseReturn.promise;
        context.markCleanupPending();
        cleanupRegistered.resolve();
        await finishReturn.promise;
        throw new Error("late rollback failed");
      }
    }));
    await returnStarted.promise;

    const cancellation = pool.cancel("late-rollback");
    releaseReturn.resolve();
    await cleanupRegistered.promise;
    const removal = pool.remove("late-rollback");
    await flush();
    expect(cleanup).not.toHaveBeenCalled();
    finishReturn.resolve();
    await cancellation;
    expect((await completion).status).toBe("cancelled");
    expect(pool.getSnapshot()["late-rollback"]).toMatchObject({
      status: "error",
      cleanupPending: true,
      error: expect.stringContaining("rollback still locked")
    });

    await expect(removal).resolves.toBe(false);
    expect(pool.getSnapshot()["late-rollback"].cleanupPending).toBe(true);
    expect((await pool.cleanup("late-rollback"))?.cleanupPending).toBe(false);
    await expect(pool.remove("late-rollback")).resolves.toBe(true);
    expect(pool.getSnapshot()["late-rollback"]).toBeUndefined();
  });

  it("cancels one task without cancelling or committing stale results from another", async () => {
    const first = deferred<string[]>();
    const second = deferred<string[]>();
    const cancelFirst = vi.fn();
    const firstReturn = vi.fn().mockResolvedValue(undefined);
    const secondReturn = vi.fn().mockResolvedValue(undefined);

    const firstCompletion = pool.enqueue(task("one", () => first.promise, {
      cancelNetwork: cancelFirst,
      returnImages: firstReturn
    }));
    const secondCompletion = pool.enqueue(task("two", () => second.promise, {
      returnImages: secondReturn
    }));
    await flush();
    await pool.cancel("one");
    first.resolve(["STALE"]);
    second.resolve(["CURRENT"]);
    await Promise.all([firstCompletion, secondCompletion]);

    expect(cancelFirst).toHaveBeenCalledOnce();
    expect(firstReturn).not.toHaveBeenCalled();
    expect(secondReturn).toHaveBeenCalledWith(["CURRENT"], expect.objectContaining({
      isCurrent: expect.any(Function)
    }));
    expect(pool.getSnapshot().one.status).toBe("cancelled");
    expect(pool.getSnapshot().two.status).toBe("success");
  });

  it("releases a network slot immediately when a cancelled request ignores abort", async () => {
    pool.setConcurrency(1);
    const stale = deferred<string[]>();
    const next = deferred<string[]>();
    const started: string[] = [];
    pool.enqueue(task("stale", async () => {
      started.push("stale");
      return await stale.promise;
    }));
    const nextCompletion = pool.enqueue(task("next", async () => {
      started.push("next");
      return await next.promise;
    }));
    await flush();

    await pool.cancel("stale");
    await flush();
    expect(started).toEqual(["stale", "next"]);

    next.resolve(["NEXT"]);
    expect((await nextCompletion).status).toBe("success");
    stale.resolve(["STALE"]);
    await flush();
    expect(pool.getSnapshot().stale.status).toBe("cancelled");
  });

  it("caches images when Photoshop is busy and supports manual return", async () => {
    const busy = new Error("Photoshop busy");
    const returnImages = vi.fn()
      .mockRejectedValueOnce(busy)
      .mockResolvedValueOnce(undefined);
    const completion = pool.enqueue(task("deferred", async () => ["IMAGE"], {
      returnImages,
      isDeferredReturnError: (error) => error === busy
    }));

    const deferredSnapshot = await completion;
    expect(deferredSnapshot).toMatchObject({
      status: "awaiting-return",
      images: ["IMAGE"],
      error: "Photoshop busy"
    });

    const returned = await pool.returnTask("deferred");
    expect(returned?.status).toBe("success");
    expect(returnImages).toHaveBeenCalledTimes(2);
  });

  it("retries failed network work with a fresh attempt and cleans resources", async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const run = vi.fn()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce(["RECOVERED"]);
    const first = await pool.enqueue(task("retry", run, { cleanup }));
    expect(first.status).toBe("error");

    const retried = await pool.retry("retry");
    expect(retried?.status).toBe("success");
    expect(run).toHaveBeenCalledTimes(2);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(pool.getSnapshot().retry.attempt).toBe(2);
  });

  it("extends a live countdown and immediately times out a request that ignores abort", async () => {
    const never = deferred<string[]>();
    const cancelNetwork = vi.fn();
    const completion = pool.enqueue(task("slow", () => never.promise, {
      timeoutSeconds: 2,
      cancelNetwork
    }));
    await flush();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(pool.getSnapshot().slow.countdown).toBe(1);
    expect(pool.extend("slow", 10)).toBe(true);
    expect(pool.getSnapshot().slow.countdown).toBe(11);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pool.getSnapshot().slow.status).toBe("running");
    await vi.advanceTimersByTimeAsync(1_000);

    expect((await completion).status).toBe("error");
    expect(pool.getSnapshot().slow.error).toBe("任务等待超时");
    expect(cancelNetwork).toHaveBeenCalledOnce();
    expect(pool.activeCount).toBe(0);
    never.resolve(["STALE"]);
    await flush();
    expect(pool.getSnapshot().slow.status).toBe("error");
  });

  it("continues queued work when every network slot times out while ignoring abort", async () => {
    const hung = [deferred<string[]>(), deferred<string[]>()];
    const started: string[] = [];
    const completions = hung.map((request, index) => pool.enqueue(task(`hung-${index}`, async () => {
      started.push(`hung-${index}`);
      return request.promise;
    }, { timeoutSeconds: 1 })));
    const queued = pool.enqueue(task("queued", async () => {
      started.push("queued");
      return ["QUEUED"];
    }, { timeoutSeconds: 10 }));
    await flush();
    expect(started).toEqual(["hung-0", "hung-1"]);

    await vi.advanceTimersByTimeAsync(1_000);
    expect((await queued).status).toBe("success");
    expect(started).toEqual(["hung-0", "hung-1", "queued"]);
    expect((await Promise.all(completions)).map(({ status }) => status)).toEqual(["error", "error"]);
    expect(pool.activeCount).toBe(0);

    hung.forEach((request) => request.resolve(["STALE"]));
    await flush();
    expect(pool.getSnapshot()["hung-0"].status).toBe("error");
    expect(pool.getSnapshot()["hung-1"].status).toBe("error");
  });

  it("queues above a changed limit and starts work when capacity increases", async () => {
    pool.setConcurrency(1);
    const releases = [deferred<string[]>(), deferred<string[]>(), deferred<string[]>()];
    const started: string[] = [];
    releases.forEach((release, index) => {
      pool.enqueue(task(String(index), async () => {
        started.push(String(index));
        return await release.promise;
      }));
    });
    await flush();
    expect(started).toEqual(["0"]);

    pool.setConcurrency(3);
    await flush();
    expect(started).toEqual(["0", "1", "2"]);
    releases.forEach((release, index) => release.resolve([String(index)]));
    await flush();
  });
});
