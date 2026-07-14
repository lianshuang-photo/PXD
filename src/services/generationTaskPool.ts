import type { AppSettings } from "../context/types";

export type GenerationTaskStatus =
  | "queued"
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
  timedOutGeneration: number | null;
  completion: Promise<GenerationTaskSnapshot>;
  resolveCompletion: (snapshot: GenerationTaskSnapshot) => void;
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
        attempt: 0,
        createdAt: this.now()
      },
      generation: 0,
      controller: null,
      networkActive: false,
      timedOutGeneration: null,
      completion: completion.promise,
      resolveCompletion: completion.resolve
    };
    this.records.set(definition.id, record);
    this.emit();
    this.pump();
    return record.completion;
  }

  async cancel(id: string): Promise<GenerationTaskSnapshot | null> {
    const record = this.records.get(id);
    if (!record || record.snapshot.status === "cancelled" || record.snapshot.status === "success") {
      return record?.snapshot ?? null;
    }
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
      status: "cancelled",
      error: undefined,
      countdown: 0
    };
    record.resolveCompletion({ ...record.snapshot });
    this.emit();
    await Promise.resolve(record.definition.cleanup?.()).catch(() => undefined);
    this.pump();
    return { ...record.snapshot };
  }

  async retry(id: string): Promise<GenerationTaskSnapshot | null> {
    const record = this.records.get(id);
    if (!record) return null;
    if (record.snapshot.images?.length) return await this.returnTask(id);
    if (!isTerminal(record.snapshot.status)) return { ...record.snapshot };
    await Promise.resolve(record.definition.cleanup?.()).catch(() => undefined);
    const completion = createCompletion();
    record.completion = completion.promise;
    record.resolveCompletion = completion.resolve;
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
    const record = this.records.get(id);
    if (!record || !record.snapshot.images?.length) return record?.snapshot ?? null;
    if (record.snapshot.status === "returning") return record.completion;
    if (record.snapshot.error) {
      await Promise.resolve(record.definition.cleanup?.()).catch(() => undefined);
    }
    const generation = record.generation;
    return await this.attemptReturn(record, generation);
  }

  async remove(id: string) {
    const record = this.records.get(id);
    if (!record) return false;
    if (record.snapshot.status !== "success") await this.cancel(id);
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
    record.timedOutGeneration = null;
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
        progress: 1,
        countdown: 0,
        images: images.slice(),
        error: undefined
      };
      try {
        await record.definition.onResult?.(images.slice());
      } catch {
        // History and other consumers are best-effort and must not discard generated images.
      }
      this.releaseNetwork(record);
      if (record.snapshot.autoReturn) {
        await this.attemptReturn(record, generation);
      } else {
        record.snapshot = { ...record.snapshot, status: "awaiting-return" };
        record.resolveCompletion({ ...record.snapshot });
        this.emit();
      }
    } catch (error) {
      if (record.generation !== generation) return;
      const timedOut = record.timedOutGeneration === generation;
      const cancelled = record.definition.isCancelledError?.(error) || record.controller.signal.aborted;
      record.snapshot = {
        ...record.snapshot,
        status: timedOut ? "error" : cancelled ? "cancelled" : "error",
        countdown: 0,
        error: timedOut ? "任务等待超时" : cancelled ? undefined : (record.definition.formatError ?? defaultFormatError)(error)
      };
      record.resolveCompletion({ ...record.snapshot });
      this.emit();
    } finally {
      this.releaseNetwork(record);
    }
  }

  private async attemptReturn(record: TaskRecord, generation: number): Promise<GenerationTaskSnapshot> {
    if (record.generation !== generation || !record.snapshot.images?.length) return { ...record.snapshot };
    record.snapshot = { ...record.snapshot, status: "returning", error: undefined };
    this.emit();
    try {
      await record.definition.returnImages(record.snapshot.images.slice(), {
        isCurrent: () => record.generation === generation && record.snapshot.status === "returning"
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
        await Promise.resolve(record.definition.cleanup?.()).catch(() => undefined);
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
      if (remainingMs <= 0 && !record.controller?.signal.aborted) {
        record.timedOutGeneration = record.generation;
        record.controller?.abort();
        try {
          record.definition.cancelNetwork?.();
        } catch {
          // The aborted request will still settle through the normal error path.
        }
      }
    }
    if (changed) this.emit();
  }

  private prune() {
    if (this.records.size < this.maxRetainedTasks) return;
    const removable = Array.from(this.records.values())
      .filter(({ snapshot, networkActive }) =>
        isPrunable(snapshot.status) &&
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
