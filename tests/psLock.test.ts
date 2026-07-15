import { expect, test } from "vitest";
import {
  acquirePSLock,
  clearPSLockQueue,
  PSCircuitOpenError,
  PSLockCancelledError,
  PSLateCleanupError,
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

test("a timed-out operation opens the circuit until its underlying work settles", async () => {
  let settleHungOperation: (() => void) | undefined;
  const hungOperation = new Promise<void>((resolve) => {
    settleHungOperation = resolve;
  });
  let activeOperations = 0;
  let maximumActiveOperations = 0;
  const timedOut = runPSExclusive(() => hungOperation, { taskId: "hung", timeoutMs: 20 });
  const following = runPSExclusive(() => {
    activeOperations += 1;
    maximumActiveOperations = Math.max(maximumActiveOperations, activeOperations);
    activeOperations -= 1;
    return "continued";
  }, { taskId: "next", timeoutMs: 1_000 });
  const followingAssertion = expect(following).rejects.toMatchObject({
    name: PSCircuitOpenError.name,
    blockingTaskId: "hung",
    taskId: "next"
  });

  await expect(timedOut).rejects.toMatchObject({
    name: PSOperationTimeoutError.name,
    timeoutMs: 20,
    taskId: "hung"
  });
  await followingAssertion;

  const duringCircuit = runPSExclusive(() => "must not run", {
    taskId: "during-circuit",
    timeoutMs: 1_000
  });
  await expect(duringCircuit).rejects.toMatchObject({
    name: PSCircuitOpenError.name,
    blockingTaskId: "hung",
    taskId: "during-circuit"
  });
  expect(maximumActiveOperations).toBe(0);

  settleHungOperation?.();
  await delay(200);

  const recovered = runPSExclusive(() => {
    activeOperations += 1;
    maximumActiveOperations = Math.max(maximumActiveOperations, activeOperations);
    activeOperations -= 1;
    return "recovered";
  }, { taskId: "recovered", timeoutMs: 1_000 });
  await expect(recovered).resolves.toBe("recovered");
  expect(maximumActiveOperations).toBe(1);
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

test("waitForLateSettlement keeps the caller pending through cleanup", async () => {
  let settle: ((value: number) => void) | undefined;
  const operation = new Promise<number>((resolve) => { settle = resolve; });
  let cleaned = false;
  let callerSettled = false;
  const timedOut = runPSExclusive(() => operation, {
    taskId: "wait-late",
    timeoutMs: 20,
    waitForLateSettlement: true,
    onLateSettlement: async () => { cleaned = true; }
  }).finally(() => { callerSettled = true; });
  await delay(220);
  expect(callerSettled).toBe(false);
  settle?.(42);
  await expect(timedOut).rejects.toBeInstanceOf(PSOperationTimeoutError);
  expect(cleaned).toBe(true);
  await delay(200);
});

test("a failed late cleanup keeps the circuit open and reaches the waiting caller", async () => {
  let settle: (() => void) | undefined;
  const operation = new Promise<void>((resolve) => { settle = resolve; });
  const timedOut = runPSExclusive(() => operation, {
    taskId: "cleanup-failed",
    timeoutMs: 20,
    waitForLateSettlement: true,
    onLateSettlement: async () => { throw new Error("cleanup failed"); }
  });
  await delay(220);
  settle?.();
  await expect(timedOut).rejects.toBeInstanceOf(PSLateCleanupError);
  await expect(runPSExclusive(() => "must not run", {
    taskId: "after-cleanup-failure",
    timeoutMs: 1000
  })).rejects.toBeInstanceOf(PSCircuitOpenError);
});
