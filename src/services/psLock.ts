const DEFAULT_TIMEOUT_MS = 180_000;
const RELEASE_COOLDOWN_MS = 150;

interface LockWaiter {
  taskId?: string;
  resolve: (release: () => void) => void;
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

const waiters: LockWaiter[] = [];
let isLocked = false;
let cooldownTimer: ReturnType<typeof setTimeout> | null = null;

const dispatchNext = () => {
  if (isLocked || cooldownTimer) {
    return;
  }

  const waiter = waiters.shift();
  if (!waiter) {
    return;
  }

  isLocked = true;
  let released = false;
  waiter.resolve(() => {
    if (released) {
      return;
    }
    released = true;
    isLocked = false;
    cooldownTimer = setTimeout(() => {
      cooldownTimer = null;
      dispatchNext();
    }, RELEASE_COOLDOWN_MS);
  });
};

export const acquirePSLock = (taskId?: string): Promise<() => void> =>
  new Promise((resolve, reject) => {
    waiters.push({ taskId, resolve, reject });
    dispatchNext();
  });

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
  const operationPromise = Promise.resolve().then(operation);
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutTimer = setTimeout(() => {
      reject(new PSOperationTimeoutError(timeoutMs, options.taskId));
    }, timeoutMs);
  });

  try {
    return await Promise.race([operationPromise, timeoutPromise]);
  } finally {
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
    }
    release();
  }
};
