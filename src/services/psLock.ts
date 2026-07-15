const DEFAULT_TIMEOUT_MS = 180_000;
const RELEASE_COOLDOWN_MS = 150;

interface LockWaiter {
  taskId?: string;
  resolve: (release: (keepCircuitOpen?: boolean) => void) => void;
  reject: (error: Error) => void;
}

export interface PSExclusiveOptions {
  taskId?: string;
  timeoutMs?: number;
}

export class PSLockCancelledError extends Error {
  constructor(taskId?: string) {
    super(taskId ? `Photoshop operation cancelled for task ${taskId}` : "Photoshop operation cancelled");
    this.name = "PSLockCancelledError";
  }
}

export class PSOperationTimeoutError extends Error {
  readonly timeoutMs: number;
  readonly taskId?: string;

  constructor(timeoutMs: number, taskId?: string) {
    const taskSuffix = taskId ? ` for task ${taskId}` : "";
    super(`Photoshop operation timed out after ${timeoutMs}ms${taskSuffix}`);
    this.name = "PSOperationTimeoutError";
    this.timeoutMs = timeoutMs;
    this.taskId = taskId;
  }
}

export class PSCircuitOpenError extends Error {
  readonly blockingTaskId?: string;
  readonly taskId?: string;

  constructor(blockingTaskId?: string, taskId?: string) {
    const blockingSuffix = blockingTaskId ? ` after task ${blockingTaskId} timed out` : "";
    super(`Photoshop operation circuit is open${blockingSuffix}`);
    this.name = "PSCircuitOpenError";
    this.blockingTaskId = blockingTaskId;
    this.taskId = taskId;
  }
}

export const isPSLockControlError = (
  error: unknown
): error is PSLockCancelledError | PSOperationTimeoutError | PSCircuitOpenError =>
  error instanceof PSLockCancelledError ||
  error instanceof PSOperationTimeoutError ||
  error instanceof PSCircuitOpenError;

const waiters: LockWaiter[] = [];
let isLocked = false;
let isCircuitOpen = false;
let circuitBlockingTaskId: string | undefined;
let cooldownTimer: ReturnType<typeof setTimeout> | null = null;
const circuitCloseWaiters = new Set<() => void>();
const taskSettlements = new Map<string, Promise<unknown | null>>();

const recoveryFailed = (error: unknown) => Boolean(
  error && typeof error === "object" && (error as { recoveryFailed?: unknown }).recoveryFailed === true
);

const openCircuit = (blockingTaskId?: string) => {
  if (isCircuitOpen) {
    return;
  }
  isCircuitOpen = true;
  circuitBlockingTaskId = blockingTaskId;
  const queued = waiters.splice(0);
  for (const waiter of queued) {
    waiter.reject(new PSCircuitOpenError(blockingTaskId, waiter.taskId));
  }
};

const dispatchNext = () => {
  if (isLocked || isCircuitOpen || cooldownTimer) {
    return;
  }

  const waiter = waiters.shift();
  if (!waiter) {
    return;
  }

  isLocked = true;
  let released = false;
  waiter.resolve((keepCircuitOpen = false) => {
    if (released) {
      return;
    }
    released = true;
    isLocked = false;
    if (keepCircuitOpen) {
      openCircuit(waiter.taskId);
      return;
    }
    cooldownTimer = setTimeout(() => {
      cooldownTimer = null;
      isCircuitOpen = false;
      circuitBlockingTaskId = undefined;
      for (const resolve of circuitCloseWaiters) resolve();
      circuitCloseWaiters.clear();
      dispatchNext();
    }, RELEASE_COOLDOWN_MS);
  });
};

const waitForCircuitClose = () => {
  if (!isCircuitOpen) return Promise.resolve();
  return new Promise<void>((resolve) => circuitCloseWaiters.add(resolve));
};

export const waitForPSTaskSettlement = async (taskId: string): Promise<void> => {
  const settlement = taskSettlements.get(taskId);
  if (!settlement) return;
  const lateRecoveryError = await settlement;
  if (lateRecoveryError) throw lateRecoveryError;
};

export const acquirePSLock = (taskId?: string): Promise<(keepCircuitOpen?: boolean) => void> => {
  if (isCircuitOpen) {
    return Promise.reject(new PSCircuitOpenError(circuitBlockingTaskId, taskId));
  }
  return new Promise((resolve, reject) => {
    waiters.push({ taskId, resolve, reject });
    dispatchNext();
  });
};

// UXP cannot cancel an active modal operation, so cancellation only removes pending waiters.
export const clearPSLockQueue = (taskId?: string): number => {
  let cleared = 0;
  for (let index = waiters.length - 1; index >= 0; index -= 1) {
    const waiter = waiters[index];
    if (taskId === undefined || waiter.taskId === taskId) {
      waiters.splice(index, 1);
      cleared += 1;
      waiter.reject(new PSLockCancelledError(waiter.taskId));
    }
  }
  return cleared;
};

export const runPSExclusive = async <T>(
  operation: () => Promise<T> | T,
  options: PSExclusiveOptions = {}
): Promise<T> => {
  const release = await acquirePSLock(options.taskId);
  const timeoutMs =
    typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  const operationPromise = Promise.resolve().then(operation);
  // UXP cannot cancel a running modal, so a timeout must not unlock concurrent work.
  const settlement = operationPromise.then(
    async () => {
      release();
      if (timedOut) await waitForCircuitClose();
      return null;
    },
    async (error) => {
      const lateRecoveryError = timedOut && recoveryFailed(error) ? error : null;
      release(Boolean(lateRecoveryError));
      if (timedOut && !lateRecoveryError) await waitForCircuitClose();
      return lateRecoveryError;
    }
  );
  if (options.taskId) {
    taskSettlements.set(options.taskId, settlement);
    while (taskSettlements.size > 128) {
      const oldest = taskSettlements.keys().next().value;
      if (oldest === undefined) break;
      taskSettlements.delete(oldest);
    }
  }
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      const error = new PSOperationTimeoutError(timeoutMs, options.taskId);
      openCircuit(options.taskId);
      reject(error);
    }, timeoutMs);
  });

  try {
    return await Promise.race([operationPromise, timeoutPromise]);
  } finally {
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
    }
  }
};
