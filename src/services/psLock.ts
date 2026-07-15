const DEFAULT_TIMEOUT_MS = 180_000;
const RELEASE_COOLDOWN_MS = 150;

interface LockWaiter {
  taskId?: string;
  resolve: (release: (options?: { keepCircuitOpen?: boolean }) => void) => void;
  reject: (error: Error) => void;
}

export interface PSExclusiveOptions<T = unknown> {
  taskId?: string;
  timeoutMs?: number;
  waitForLateSettlement?: boolean;
  onLateSettlement?: (settlement:
    | { status: "fulfilled"; value: T }
    | { status: "rejected"; reason: unknown }
  ) => Promise<void> | void;
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

export class PSLateCleanupError extends Error {
  readonly timeoutError: PSOperationTimeoutError;
  readonly cleanupError: unknown;

  constructor(timeoutError: PSOperationTimeoutError, cleanupError: unknown) {
    super(
      `${timeoutError.message}; late Photoshop cleanup failed: ` +
      `${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
    );
    this.name = "PSLateCleanupError";
    this.timeoutError = timeoutError;
    this.cleanupError = cleanupError;
  }
}

export const isPSLockControlError = (
  error: unknown
): error is PSLockCancelledError | PSOperationTimeoutError | PSCircuitOpenError | PSLateCleanupError =>
  error instanceof PSLockCancelledError ||
  error instanceof PSOperationTimeoutError ||
  error instanceof PSCircuitOpenError ||
  error instanceof PSLateCleanupError;

const waiters: LockWaiter[] = [];
let isLocked = false;
let isCircuitOpen = false;
let circuitBlockingTaskId: string | undefined;
let cooldownTimer: ReturnType<typeof setTimeout> | null = null;

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
  waiter.resolve((options = {}) => {
    if (released) {
      return;
    }
    released = true;
    isLocked = false;
    if (options.keepCircuitOpen) return;
    cooldownTimer = setTimeout(() => {
      cooldownTimer = null;
      isCircuitOpen = false;
      circuitBlockingTaskId = undefined;
      dispatchNext();
    }, RELEASE_COOLDOWN_MS);
  });
};

export const acquirePSLock = (
  taskId?: string
): Promise<(options?: { keepCircuitOpen?: boolean }) => void> => {
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
  options: PSExclusiveOptions<T> = {}
): Promise<T> => {
  const release = await acquirePSLock(options.taskId);
  const timeoutMs =
    typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  let lateCleanupError: unknown;
  const operationPromise = Promise.resolve().then(operation);
  const settledPromise = operationPromise.then(
    async (value) => {
      if (timedOut && options.onLateSettlement) {
        try {
          await options.onLateSettlement({ status: "fulfilled", value });
        } catch (error) {
          lateCleanupError = error;
          throw error;
        }
      }
      return value;
    },
    async (reason) => {
      if (timedOut && options.onLateSettlement) {
        try {
          await options.onLateSettlement({ status: "rejected", reason });
        } catch (error) {
          lateCleanupError = error;
          throw error;
        }
      }
      throw reason;
    }
  );
  // UXP cannot cancel a running modal, so a timeout must not unlock concurrent work.
  void settledPromise.then(
    () => release({ keepCircuitOpen: lateCleanupError !== undefined }),
    () => release({ keepCircuitOpen: lateCleanupError !== undefined })
  );
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      const error = new PSOperationTimeoutError(timeoutMs, options.taskId);
      openCircuit(options.taskId);
      reject(error);
    }, timeoutMs);
  });

  try {
    try {
      return await Promise.race([settledPromise, timeoutPromise]);
    } catch (error) {
      if (error instanceof PSOperationTimeoutError && options.waitForLateSettlement) {
        try {
          await settledPromise;
        } catch {
          if (lateCleanupError !== undefined) {
            throw new PSLateCleanupError(error, lateCleanupError);
          }
        }
      }
      throw error;
    }
  } finally {
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
    }
  }
};
