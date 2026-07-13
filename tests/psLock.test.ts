import assert from "node:assert/strict";
import test from "node:test";
import {
  acquirePSLock,
  clearPSLockQueue,
  PSLockCancelledError,
  PSOperationTimeoutError,
  runPSExclusive
} from "../src/services/psLock.ts";

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });

test("runPSExclusive executes queued operations in FIFO order without overlap", async () => {
  const events: string[] = [];
  let activeOperations = 0;
  let maximumActiveOperations = 0;

  const runOperation = (id: string) =>
    runPSExclusive(async () => {
      events.push(`start-${id}`);
      activeOperations += 1;
      maximumActiveOperations = Math.max(maximumActiveOperations, activeOperations);
      await delay(5);
      activeOperations -= 1;
      events.push(`end-${id}`);
    });

  await Promise.all([runOperation("a"), runOperation("b"), runOperation("c")]);

  assert.equal(maximumActiveOperations, 1);
  assert.deepEqual(events, ["start-a", "end-a", "start-b", "end-b", "start-c", "end-c"]);
});

test("a timed-out operation rejects and releases the next queue entry", async () => {
  const neverSettles = new Promise<void>(() => undefined);
  const timedOut = runPSExclusive(() => neverSettles, { taskId: "hung", timeoutMs: 20 });
  const following = runPSExclusive(() => "continued", { taskId: "next", timeoutMs: 500 });

  await assert.rejects(
    timedOut,
    (error: unknown) =>
      error instanceof PSOperationTimeoutError && error.timeoutMs === 20 && error.taskId === "hung"
  );
  assert.equal(await following, "continued");
});

test("clearPSLockQueue only rejects pending entries for the selected task", async () => {
  const releaseActive = await acquirePSLock("active");
  const cancelled = acquirePSLock("cancelled");
  const retained = acquirePSLock("retained");
  const cancelledAssertion = assert.rejects(
    cancelled,
    (error: unknown) => error instanceof PSLockCancelledError
  );

  assert.equal(clearPSLockQueue("cancelled"), 1);
  assert.equal(clearPSLockQueue("missing"), 0);
  releaseActive();

  await cancelledAssertion;
  const releaseRetained = await retained;
  releaseRetained();
});
