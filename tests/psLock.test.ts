import { expect, test } from "vitest";
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

  expect(maximumActiveOperations).toBe(1);
  expect(events).toEqual(["start-a", "end-a", "start-b", "end-b", "start-c", "end-c"]);
});

test("a timed-out operation keeps the queue blocked until the underlying work settles", async () => {
  let settleHungOperation: (() => void) | undefined;
  const hungOperation = new Promise<void>((resolve) => {
    settleHungOperation = resolve;
  });
  let followingStarted = false;
  const timedOut = runPSExclusive(() => hungOperation, { taskId: "hung", timeoutMs: 20 });
  const following = runPSExclusive(() => {
    followingStarted = true;
    return "continued";
  }, { taskId: "next", timeoutMs: 1_000 });

  await expect(timedOut).rejects.toMatchObject({
    name: PSOperationTimeoutError.name,
    timeoutMs: 20,
    taskId: "hung"
  });
  await delay(200);
  expect(followingStarted).toBe(false);

  settleHungOperation?.();
  await expect(following).resolves.toBe("continued");
});

test("clearPSLockQueue only rejects pending entries for the selected task", async () => {
  const releaseActive = await acquirePSLock("active");
  const cancelled = acquirePSLock("cancelled");
  const retained = acquirePSLock("retained");
  const cancelledAssertion = expect(cancelled).rejects.toBeInstanceOf(PSLockCancelledError);

  expect(clearPSLockQueue("cancelled")).toBe(1);
  expect(clearPSLockQueue("missing")).toBe(0);
  releaseActive();

  await cancelledAssertion;
  const releaseRetained = await retained;
  releaseRetained();
});
