import type { AppSettings } from "../context/types";

export type GenerationTaskStatus =
  | "queued"
  | "retrying"
  | "cancelling"
  | "running"
  | "returning"
  | "awaiting-return"
  | "success"
  | "cancelled"
  | "error";

export interface GenerationTaskSnapshot {
  id: string;
  title: string;
  engine: AppSettings["imageProvider"];
  status: GenerationTaskStatus;
  progress: number;
  countdown: number;
  autoReturn: boolean;
  images?: string[];
  error?: string;
  cleanupPending: boolean;
  attempt: number;
  createdAt: number;
  startedAt?: number;
  deadlineAt?: number;
}

export interface GenerationTaskRunContext {
  signal: AbortSignal;
  updateProgress: (progress: number) => void;
}

export interface GenerationTaskReturnContext {
  isCurrent: () => boolean;
  markCleanupPending: () => void;
}

export interface GenerationTaskDefinition {
  id: string;
  title: string;
  engine: AppSettings["imageProvider"];
  timeoutSeconds: number;
  autoReturn?: boolean;
  run: (context: GenerationTaskRunContext) => Promise<string[]>;
  returnImages: (images: string[], context: GenerationTaskReturnContext) => Promise<void>;
  cancelNetwork?: () => void;
  clearPendingReturn?: () => void;
  cleanup?: () => Promise<void> | void;
  onResult?: (images: string[]) => Promise<void> | void;
  isCancelledError?: (error: unknown) => boolean;
  isDeferredReturnError?: (error: unknown) => boolean;
  formatError?: (error: unknown) => string;
}

interface TaskRecord {
  definition: GenerationTaskDefinition;
  snapshot: GenerationTaskSnapshot;
  generation: number;
  controller: AbortController | null;
  networkActive: boolean;
  completion: Promise<GenerationTaskSnapshot>;
  resolveCompletion: (snapshot: GenerationTaskSnapshot) => void;
  retryPromise: Promise<GenerationTaskSnapshot | null> | null;
  cleanupPromise: Promise<boolean> | null;
  returnPromise: Promise<GenerationTaskSnapshot> | null;
  cancelPromise: Promise<GenerationTaskSnapshot> | null;
}

export interface GenerationTaskPoolOptions {
  concurrency?: number;
  maxRetainedTasks?: number;
  tickMs?: number;
  now?: () => number;
}

const clampConcurrency = (value: number) =>
  Number.isFinite(value) ? Math.max(1, Math.min(8, Math.floor(value))) : 4;

const clampProgress = (value: number) =>
  Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

const defaultFormatError = (error: unknown) =>
  error instanceof Error ? error.message : "任务执行失败";

const createCompletion = () => {
  let resolve!: (snapshot: GenerationTaskSnapshot) => void;
  const promise = new Promise<GenerationTaskSnapshot>((candidate) => {
    resolve = candidate;
  });
  return { promise, resolve };
};

const isTerminal = (status: GenerationTaskStatus) =>
  status === "success" || status === "cancelled" || status === "error" || status === "awaiting-return";

const isPrunable = (status: GenerationTaskStatus) =>
  status === "success" || status === "cancelled" || status === "error";

export class GenerationTaskPool {
  private readonly records = new Map<string, TaskRecord>();
  private readonly listeners = new Set<(tasks: Record<string, GenerationTaskSnapshot>) => void>();
  private readonly now: () => number;
  private readonly maxRetainedTasks: number;
  private readonly timer: ReturnType<typeof setInterval>;
  private concurrency: number;
  private activeNetworks = 0;
  private returnQueue: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(options: GenerationTaskPoolOptions = {}) {
    this.concurrency = clampConcurrency(options.concurrency ?? 4);
    this.maxRetainedTasks = Math.max(8, Math.floor(options.maxRetainedTasks ?? 50));
    this.now = options.now ?? Date.now;
    this.timer = setInterval(() => this.tick(), Math.max(50, options.tickMs ?? 1_000));
  }

  get limit() {
    return this.concurrency;
  }

  get activeCount() {
    return this.activeNetworks;
  }

  getSnapshot(): Record<string, GenerationTaskSnapshot> {
    return Object.fromEntries(
      Array.from(this.records, ([id, record]) => [id, { ...record.snapshot, images: record.snapshot.images?.slice() }])
    );
  }

  subscribe(listener: (tasks: Record<string, GenerationTaskSnapshot>) => void) {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  setConcurrency(value: number) {
    this.concurrency = clampConcurrency(value);
    this.pump();
  }

  enqueue(definition: GenerationTaskDefinition): Promise<GenerationTaskSnapshot> {
    if (this.disposed) throw new Error("Task pool is disposed");
    if (!definition.id) throw new Error("Task id is required");
    if (this.records.has(definition.id)) throw new Error(`Task ${definition.id} already exists`);
    this.prune();
    const completion = createCompletion();
    const record: TaskRecord = {
      definition,
      snapshot: {
        id: definition.id,
        title: definition.title,
        engine: definition.engine,
        status: "queued",
        progress: 0,
        countdown: Math.max(1, Math.ceil(definition.timeoutSeconds)),
        autoReturn: definition.autoReturn !== false,
        cleanupPending: false,
        attempt: 0,
        createdAt: this.now()
      },
      generation: 0,
      controller: null,
      networkActive: false,
      completion: completion.promise,
      resolveCompletion: completion.resolve,
      retryPromise: null,
      cleanupPromise: null,
      returnPromise: null,
      cancelPromise: null
    };
    this.records.set(definition.id, record);
    this.emit();
    this.pump();
    return record.completion;
  }

  async cancel(id: string): Promise<GenerationTaskSnapshot | null> {
    const record = this.records.get(id);
    if (!record) return null;
    if (record.cancelPromise) return await record.cancelPromise;
    if (record.snapshot.status === "cancelled" || record.snapshot.status === "success") {
      return record?.snapshot ?? null;
    }
    let settleCancel!: (snapshot: GenerationTaskSnapshot) => void;
    const cancelPromise = new Promise<GenerationTaskSnapshot>((resolve) => {
      settleCancel = resolve;
    });
    record.cancelPromise = cancelPromise;
    try {
      const result = await this.performCancel(record);
      settleCancel(result);
      return result;
    } catch (error) {
      settleCancel({ ...record.snapshot });
      throw error;
    } finally {
      if (record.cancelPromise === cancelPromise) record.cancelPromise = null;
    }
  }

  private async performCancel(record: TaskRecord): Promise<GenerationTaskSnapshot> {
    const activeReturn = record.returnPromise;
    record.generation += 1;
    record.controller?.abort();
    try {
      record.definition.cancelNetwork?.();
    } catch {
      // Cancellation must still release capacity when a client cleanup hook fails.
    }
    try {
      record.definition.clearPendingReturn?.();
    } catch {
      // The task state remains authoritative even if a host queue cleanup fails.
    }
    this.releaseNetwork(record);
    record.snapshot = {
      ...record.snapshot,
      status: "cancelling",
      error: undefined,
      countdown: 0
    };
    this.emit();
    if (activeReturn) await activeReturn;
    await this.runCleanup(record);
    if (record.snapshot.status === "cancelling") {
      record.snapshot = { ...record.snapshot, status: "cancelled" };
    }
    record.resolveCompletion({ ...record.snapshot });
    this.emit();
    this.pump();
    return { ...record.snapshot };
  }

  async retry(id: string): Promise<GenerationTaskSnapshot | null> {
    let record = this.records.get(id);
    if (!record) return null;
    if (record.cancelPromise) {
      await record.cancelPromise;
      record = this.records.get(id);
      if (!record) return null;
    }
    if (record.retryPromise) return await record.retryPromise;
    if (record.snapshot.cleanupPending || !isTerminal(record.snapshot.status)) return { ...record.snapshot };
    const retryPromise = this.performRetry(record);
    record.retryPromise = retryPromise;
    try {
      return await retryPromise;
    } finally {
      if (record.retryPromise === retryPromise) record.retryPromise = null;
    }
  }

  async cleanup(id: string): Promise<GenerationTaskSnapshot | null> {
    let record = this.records.get(id);
    if (!record) return null;
    if (record.cancelPromise) await record.cancelPromise;
    else if (record.returnPromise) await record.returnPromise;
    record = this.records.get(id);
    if (!record) return null;
    await this.runCleanup(record);
    return { ...record.snapshot };
  }

  extend(id: string, seconds = 10) {
    const record = this.records.get(id);
    if (!record || seconds <= 0) return false;
    const extensionMs = Math.round(seconds * 1_000);
    record.snapshot = {
      ...record.snapshot,
      deadlineAt: record.snapshot.deadlineAt == null ? undefined : record.snapshot.deadlineAt + extensionMs,
      countdown: record.snapshot.countdown + Math.ceil(seconds)
    };
    this.emit();
    return true;
  }

  setAutoReturn(id: string, autoReturn: boolean) {
    const record = this.records.get(id);
    if (!record) return false;
    record.snapshot = { ...record.snapshot, autoReturn };
    this.emit();
    if (autoReturn && record.snapshot.status === "awaiting-return" && record.snapshot.images?.length) {
      void this.returnTask(id);
    }
    return true;
  }

  async returnTask(id: string): Promise<GenerationTaskSnapshot | null> {
    let record = this.records.get(id);
    if (!record || !record.snapshot.images?.length) return record?.snapshot ?? null;
    if (record.cancelPromise) {
      await record.cancelPromise;
      record = this.records.get(id);
      if (!record || !record.snapshot.images?.length) return record?.snapshot ?? null;
    }
    if (record.snapshot.cleanupPending) return { ...record.snapshot };
    if (record.returnPromise) {
      if (record.snapshot.status === "returning") return await record.returnPromise;
      await record.returnPromise;
      record = this.records.get(id);
      if (!record || !record.snapshot.images?.length) return record?.snapshot ?? null;
      if (record.snapshot.cleanupPending) return { ...record.snapshot };
    }
    const generation = record.generation;
    return await this.attemptReturn(record, generation);
  }

  async remove(id: string) {
    let record = this.records.get(id);
    if (!record) return false;
    if (record.cancelPromise) await record.cancelPromise;
    else if (record.returnPromise) {
      if (record.snapshot.status === "success") await record.returnPromise;
      else await this.cancel(id);
    }
    record = this.records.get(id);
    if (!record) return false;
    if (record.snapshot.cleanupPending) return false;
    if (record.snapshot.status !== "success") await this.cancel(id);
    if (record.snapshot.cleanupPending) return false;
    this.records.delete(id);
    this.emit();
    return true;
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.timer);
    await Promise.all(Array.from(this.records.keys(), (id) => this.cancel(id)));
    this.listeners.clear();
  }

  private emit() {
    if (this.disposed) return;
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  private pump() {
    if (this.disposed) return;
    while (this.activeNetworks < this.concurrency) {
      const next = Array.from(this.records.values()).find(({ snapshot }) => snapshot.status === "queued");
      if (!next) break;
      void this.startNetwork(next);
    }
  }

  private async startNetwork(record: TaskRecord) {
    const generation = ++record.generation;
    const startedAt = this.now();
    const timeoutMs = Math.max(1_000, Math.round(record.definition.timeoutSeconds * 1_000));
    record.controller = new AbortController();
    record.networkActive = true;
    this.activeNetworks += 1;
    record.snapshot = {
      ...record.snapshot,
      status: "running",
      progress: 0,
      countdown: Math.ceil(timeoutMs / 1_000),
      error: undefined,
      images: undefined,
      attempt: record.snapshot.attempt + 1,
      startedAt,
      deadlineAt: startedAt + timeoutMs
    };
    this.emit();
    try {
      const images = await record.definition.run({
        signal: record.controller.signal,
        updateProgress: (progress) => {
          if (record.generation !== generation || record.snapshot.status !== "running") return;
          record.snapshot = { ...record.snapshot, progress: clampProgress(progress) };
          this.emit();
        }
      });
      if (record.generation !== generation) return;
      if (!images.length) throw new Error("任务未返回图像");
      record.snapshot = {
        ...record.snapshot,
        status: "returning",
        progress: 1,
        countdown: 0,
        images: images.slice(),
        error: undefined
      };
      this.emit();
      this.releaseNetwork(record);
      try {
        await record.definition.onResult?.(images.slice());
      } catch {
        // History and other consumers are best-effort and must not discard generated images.
      }
      if (record.generation !== generation) return;
      if (record.snapshot.autoReturn) {
        await this.attemptReturn(record, generation);
      } else {
        record.snapshot = { ...record.snapshot, status: "awaiting-return" };
        record.resolveCompletion({ ...record.snapshot });
        this.emit();
      }
    } catch (error) {
      if (record.generation !== generation) return;
      const cancelled = record.definition.isCancelledError?.(error) || record.controller.signal.aborted;
      record.snapshot = {
        ...record.snapshot,
        status: cancelled ? "cancelled" : "error",
        countdown: 0,
        error: cancelled ? undefined : (record.definition.formatError ?? defaultFormatError)(error)
      };
      record.resolveCompletion({ ...record.snapshot });
      this.emit();
    } finally {
      this.releaseNetwork(record);
    }
  }

  private async attemptReturn(record: TaskRecord, generation: number): Promise<GenerationTaskSnapshot> {
    if (record.returnPromise) return await record.returnPromise;
    let settleReturn!: (snapshot: GenerationTaskSnapshot) => void;
    const returnPromise = new Promise<GenerationTaskSnapshot>((resolve) => {
      settleReturn = resolve;
    });
    record.returnPromise = returnPromise;
    try {
      const result = await this.performReturn(record, generation);
      settleReturn(result);
      return result;
    } catch (error) {
      settleReturn({ ...record.snapshot });
      throw error;
    } finally {
      if (record.returnPromise === returnPromise) record.returnPromise = null;
    }
  }

  private async performReturn(record: TaskRecord, generation: number): Promise<GenerationTaskSnapshot> {
    if (record.generation !== generation || !record.snapshot.images?.length) return { ...record.snapshot };
    record.snapshot = { ...record.snapshot, status: "returning", error: undefined };
    this.emit();
    try {
      await this.enqueueReturn(async () => {
        if (record.generation !== generation || record.snapshot.status !== "returning") return;
        await record.definition.returnImages(record.snapshot.images!.slice(), {
          isCurrent: () => record.generation === generation && record.snapshot.status === "returning",
          markCleanupPending: () => {
            if (record.snapshot.cleanupPending) return;
            record.snapshot = { ...record.snapshot, cleanupPending: true };
            this.emit();
          }
        });
      });
      if (record.generation !== generation) return { ...record.snapshot };
      record.snapshot = { ...record.snapshot, status: "success", error: undefined };
    } catch (error) {
      if (record.generation !== generation) return { ...record.snapshot };
      const deferred = record.definition.isDeferredReturnError?.(error) === true;
      record.snapshot = {
        ...record.snapshot,
        status: deferred ? "awaiting-return" : "error",
        error: (record.definition.formatError ?? defaultFormatError)(error)
      };
      if (!deferred) {
        await this.runCleanup(record);
      }
    }
    record.resolveCompletion({ ...record.snapshot });
    this.emit();
    return { ...record.snapshot };
  }

  private releaseNetwork(record: TaskRecord) {
    if (!record.networkActive) return;
    record.networkActive = false;
    record.controller = null;
    this.activeNetworks = Math.max(0, this.activeNetworks - 1);
    this.pump();
  }

  private async performRetry(record: TaskRecord): Promise<GenerationTaskSnapshot | null> {
    const retryGeneration = ++record.generation;
    record.snapshot = { ...record.snapshot, status: "retrying", error: undefined };
    this.emit();
    if (!(await this.runCleanup(record))) return { ...record.snapshot };
    if (record.generation !== retryGeneration || record.snapshot.status !== "retrying") {
      return { ...record.snapshot };
    }
    const completion = createCompletion();
    record.completion = completion.promise;
    record.resolveCompletion = completion.resolve;
    if (record.snapshot.images?.length) {
      return await this.attemptReturn(record, retryGeneration);
    }
    record.snapshot = {
      ...record.snapshot,
      status: "queued",
      progress: 0,
      countdown: Math.max(1, Math.ceil(record.definition.timeoutSeconds)),
      images: undefined,
      error: undefined,
      startedAt: undefined,
      deadlineAt: undefined
    };
    this.emit();
    this.pump();
    return await record.completion;
  }

  private async runCleanup(record: TaskRecord): Promise<boolean> {
    if (record.cleanupPromise) return await record.cleanupPromise;
    const cleanupPromise = Promise.resolve()
      .then(() => record.definition.cleanup?.())
      .then(() => {
        record.snapshot = { ...record.snapshot, cleanupPending: false };
        this.emit();
        return true;
      })
      .catch((error) => {
        const detail = defaultFormatError(error);
        record.snapshot = {
          ...record.snapshot,
          cleanupPending: true,
          status: "error",
          error: `Photoshop 清理未完成：${detail}`
        };
        this.emit();
        return false;
      });
    record.cleanupPromise = cleanupPromise;
    try {
      return await cleanupPromise;
    } finally {
      if (record.cleanupPromise === cleanupPromise) record.cleanupPromise = null;
    }
  }

  private async enqueueReturn<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.returnQueue.then(operation, operation);
    this.returnQueue = result.then(() => undefined, () => undefined);
    return await result;
  }

  private timeout(record: TaskRecord) {
    if (record.snapshot.status !== "running") return;
    record.generation += 1;
    record.controller?.abort();
    try {
      record.definition.cancelNetwork?.();
    } catch {
      // Timeout state must not depend on a client cancellation hook.
    }
    this.releaseNetwork(record);
    record.snapshot = {
      ...record.snapshot,
      status: "error",
      countdown: 0,
      error: "任务等待超时"
    };
    record.resolveCompletion({ ...record.snapshot });
    this.emit();
  }

  private tick() {
    const now = this.now();
    let changed = false;
    for (const record of this.records.values()) {
      if (record.snapshot.status !== "running" || record.snapshot.deadlineAt == null || record.snapshot.startedAt == null) continue;
      const remainingMs = record.snapshot.deadlineAt - now;
      const countdown = Math.max(0, Math.ceil(remainingMs / 1_000));
      const duration = Math.max(1, record.snapshot.deadlineAt - record.snapshot.startedAt);
      const estimatedProgress = Math.min(0.9, Math.max(0, (now - record.snapshot.startedAt) / duration));
      if (countdown !== record.snapshot.countdown || estimatedProgress > record.snapshot.progress) {
        record.snapshot = {
          ...record.snapshot,
          countdown,
          progress: Math.max(record.snapshot.progress, estimatedProgress)
        };
        changed = true;
      }
      if (remainingMs <= 0) this.timeout(record);
    }
    if (changed) this.emit();
  }

  private prune() {
    if (this.records.size < this.maxRetainedTasks) return;
    const removable = Array.from(this.records.values())
      .filter(({ snapshot, networkActive }) =>
        isPrunable(snapshot.status) &&
        !snapshot.cleanupPending &&
        !networkActive &&
        (snapshot.status === "success" || !snapshot.images?.length)
      )
      .sort((left, right) => left.snapshot.createdAt - right.snapshot.createdAt);
    while (this.records.size >= this.maxRetainedTasks && removable.length) {
      const record = removable.shift();
      if (record) this.records.delete(record.snapshot.id);
    }
    if (this.records.size >= this.maxRetainedTasks) {
      throw new Error(`任务池最多保留 ${this.maxRetainedTasks} 个任务，请先清理已完成任务`);
    }
  }
}
