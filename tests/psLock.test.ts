import { expect, test } from "vitest";
import {
  acquirePSLock,
  clearPSLockQueue,
  isPSBusyError,
  PSCircuitOpenError,
  PSLockCancelledError,
  PSOperationTimeoutError,
  runPSExclusive
} from "../src/services/psLock.ts";

test("isPSBusyError recognizes retryable Photoshop busy conditions through wrappers", () => {
  expect(isPSBusyError({ number: 9, message: "executeAsModal rejected" })).toBe(true);
  expect(isPSBusyError(new Error("Photoshop is busy while a brush dialog is open"))).toBe(true);
  expect(isPSBusyError(new PSOperationTimeoutError(100, "timeout"))).toBe(true);
  expect(isPSBusyError(new PSCircuitOpenError("timeout", "next"))).toBe(true);
  expect(isPSBusyError({ originalError: { code: 9 } })).toBe(true);
  expect(isPSBusyError({ cause: new Error("A modal dialog is currently active") })).toBe(true);
});

test("isPSBusyError excludes cancellation and ordinary Photoshop failures", () => {
  expect(isPSBusyError(new PSLockCancelledError("cancelled"))).toBe(false);
  expect(isPSBusyError(new Error("Could not complete because the layer is locked"))).toBe(false);
  expect(isPSBusyError({ number: 7, message: "Program error" })).toBe(false);
});

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
