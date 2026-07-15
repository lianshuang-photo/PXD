import {
  RECYCLE_BIN_IMAGE_BYTE_LIMIT,
  RECYCLE_BIN_TASK_BYTE_LIMIT,
  RECYCLE_BIN_VERSION,
  createPendingRecycleBinEntry,
  isSafeRecycleBinAssetName,
  parseRecycleBinFile,
  recoverInterruptedEntries,
  sanitizeRecycleBinParams,
  selectRecycleBinRetention,
  type RecycleBinAsset,
  type RecycleBinEntry,
  type RecycleBinFile,
  type RecycleBinTaskInput
} from "./generationRecycleBin";

export interface GenerationRecycleBinStorage {
  readIndex: () => Promise<unknown | null>;
  writeIndex: (payload: RecycleBinFile) => Promise<void>;
  writeAsset: (fileName: string, bytes: Uint8Array) => Promise<void>;
  readAsset: (fileName: string) => Promise<Uint8Array | null>;
  deleteAsset: (fileName: string) => Promise<void>;
  listAssets: () => Promise<string[]>;
}

export interface DecodedRecycleBinImage {
  mimeType: RecycleBinAsset["mimeType"];
  bytes: Uint8Array;
}

const EMPTY_FILE: RecycleBinFile = { version: RECYCLE_BIN_VERSION, entries: [] };

const decodeBase64 = (value: string): Uint8Array => {
  const binary = atob(value.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

export const decodeRecycleBinImage = (value: string): DecodedRecycleBinImage => {
  if (typeof value !== "string" || !value) throw new Error("生成结果不是有效图片");
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([a-z0-9+/=\s]+)$/i.exec(value);
  const mimeType = (match?.[1]?.toLowerCase() ?? "image/png") as RecycleBinAsset["mimeType"];
  const payload = match?.[2] ?? value;
  if (!/^[a-z0-9+/=\s]+$/i.test(payload)) throw new Error("生成结果 base64 无效");
  const bytes = decodeBase64(payload);
  if (!bytes.length || bytes.length > RECYCLE_BIN_IMAGE_BYTE_LIMIT) throw new Error("单张生成图片超过回收站限制");
  return { mimeType, bytes };
};

const extensionFor = (mimeType: RecycleBinAsset["mimeType"]) =>
  mimeType === "image/jpeg" ? "jpg" : mimeType === "image/webp" ? "webp" : "png";

const randomAssetStem = () => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().replace(/-/g, "");
  }
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  }
  throw new Error("当前环境无法生成安全的回收站文件名");
};

const createAssets = (images: DecodedRecycleBinImage[]): RecycleBinAsset[] =>
  images.map(({ mimeType, bytes }, index) => ({
    fileName: `${randomAssetStem()}_${index}.${extensionFor(mimeType)}`,
    mimeType,
    byteLength: bytes.byteLength
  }));

const cloneEntries = (entries: RecycleBinEntry[]) =>
  entries.map((entry) => ({
    ...entry,
    params: sanitizeRecycleBinParams(entry.params),
    context: {
      ...entry.context,
      selectionBounds: entry.context.selectionBounds ? { ...entry.context.selectionBounds } : undefined
    },
    assets: entry.assets.map((asset) => ({ ...asset }))
  }));

const formatError = (error: unknown) => error instanceof Error ? error.message : "生成失败";

const encodeDataUrl = (asset: RecycleBinAsset, bytes: Uint8Array) => {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, Math.min(index + chunk, bytes.length)));
  }
  return `data:${asset.mimeType};base64,${btoa(binary)}`;
};

export class GenerationRecycleBinRepository {
  private entries: RecycleBinEntry[] = [];
  private initialized = false;
  private initializePromise: Promise<RecycleBinEntry[]> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<(entries: RecycleBinEntry[]) => void>();

  constructor(
    private readonly storage: GenerationRecycleBinStorage,
    private readonly now: () => number = Date.now
  ) {}

  getSnapshot(): RecycleBinEntry[] {
    return cloneEntries(this.entries);
  }

  subscribe(listener: (entries: RecycleBinEntry[]) => void) {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  initialize(): Promise<RecycleBinEntry[]> {
    if (this.initialized) return Promise.resolve(this.getSnapshot());
    if (!this.initializePromise) {
      this.initializePromise = this.enqueue(async () => {
        const previousEntries = this.entries;
        const raw = await this.storage.readIndex();
        const parsed = raw === null ? EMPTY_FILE : parseRecycleBinFile(raw);
        const assetNames = new Set((await this.storage.listAssets()).filter(isSafeRecycleBinAssetName));
        let changed = raw === null || parsed.entries.some(({ status }) => status === "pending");
        const recovered: RecycleBinEntry[] = [];
        for (const entry of recoverInterruptedEntries(parsed.entries, this.now())) {
          const assets: RecycleBinAsset[] = [];
          for (const asset of entry.assets) {
            if (!assetNames.has(asset.fileName)) continue;
            const bytes = await this.storage.readAsset(asset.fileName);
            if (bytes?.byteLength === asset.byteLength) assets.push(asset);
          }
          if (assets.length !== entry.assets.length) {
            changed = true;
            recovered.push({
              ...entry,
              status: "failed" as const,
              assets,
              updatedAt: this.now(),
              error: "回收站图片文件不完整"
            });
          } else {
            recovered.push(entry);
          }
        }
        const { kept, removed } = selectRecycleBinRetention(recovered);
        if (removed.length) changed = true;
        this.entries = kept;
        try {
          if (changed) await this.persist();
        } catch (error) {
          this.entries = previousEntries;
          this.emit();
          throw error;
        }
        const referenced = new Set(this.entries.flatMap(({ assets }) => assets.map(({ fileName }) => fileName)));
        await Promise.all(Array.from(assetNames, (fileName) =>
          referenced.has(fileName) ? Promise.resolve() : this.storage.deleteAsset(fileName).catch(() => undefined)
        ));
        this.initialized = true;
        this.emit();
        return this.getSnapshot();
      }).catch((error) => {
        this.initializePromise = null;
        throw error;
      });
    }
    return this.initializePromise;
  }

  async begin(input: RecycleBinTaskInput): Promise<RecycleBinEntry> {
    await this.initialize();
    return await this.enqueue(async () => {
      const previousEntries = this.entries;
      const previous = this.entries.find(({ taskId }) => taskId === input.taskId);
      const entry = createPendingRecycleBinEntry(input, this.now());
      this.entries = [entry, ...this.entries.filter(({ taskId }) => taskId !== entry.taskId)];
      try {
        await this.persistAndPrune();
      } catch (error) {
        this.entries = previousEntries;
        this.emit();
        throw error;
      }
      await this.deleteAssets(previous?.assets ?? []);
      return { ...entry };
    });
  }

  async complete(taskId: string, imageValues: string[]): Promise<RecycleBinEntry | null> {
    await this.initialize();
    const images = imageValues.map(decodeRecycleBinImage);
    const totalBytes = images.reduce((total, image) => total + image.bytes.byteLength, 0);
    if (!images.length) throw new Error("任务未返回可归档图片");
    if (totalBytes > RECYCLE_BIN_TASK_BYTE_LIMIT) throw new Error("单个任务图片超过回收站限制");
    return await this.enqueue(async () => {
      const current = this.entries.find(({ taskId: candidate }) => candidate === taskId);
      if (!current || current.status === "success") return current ? { ...current } : null;
      const originalEntries = this.entries;
      const assets = createAssets(images);
      this.entries = this.entries.map((entry) => entry.taskId === taskId ? {
        ...entry,
        status: "pending" as const,
        updatedAt: this.now(),
        assets,
        error: undefined
      } : entry);
      try {
        await this.persist();
      } catch (error) {
        this.entries = originalEntries;
        this.emit();
        throw error;
      }
      const pendingEntries = this.entries;
      try {
        for (let index = 0; index < assets.length; index += 1) {
          await this.storage.writeAsset(assets[index].fileName, images[index].bytes);
          const verified = await this.storage.readAsset(assets[index].fileName);
          if (!verified || verified.byteLength !== images[index].bytes.byteLength ||
              verified.some((value, byteIndex) => value !== images[index].bytes[byteIndex])) {
            throw new Error("图片文件写入校验失败");
          }
        }
        let completed: RecycleBinEntry | null = null;
        this.entries = this.entries.map((entry) => {
          if (entry.taskId !== taskId) return entry;
          completed = { ...entry, status: "success", updatedAt: this.now(), error: undefined };
          return completed;
        });
        await this.persistAndPrune();
        return completed ? { ...(completed as RecycleBinEntry) } : null;
      } catch (error) {
        await this.deleteAssets(assets);
        this.entries = this.entries.map((entry) => entry.taskId === taskId ? {
          ...entry,
          status: "failed" as const,
          updatedAt: this.now(),
          assets: [],
          error: `图片归档失败：${formatError(error)}`
        } : entry);
        try {
          await this.persist();
        } catch {
          this.entries = pendingEntries;
          this.emit();
        }
        throw error;
      }
    });
  }

  async fail(taskId: string, error: unknown): Promise<RecycleBinEntry | null> {
    return await this.setTerminal(taskId, "failed", formatError(error));
  }

  async abort(taskId: string, reason = "任务已取消"): Promise<RecycleBinEntry | null> {
    return await this.setTerminal(taskId, "aborted", reason);
  }

  async readImages(taskId: string): Promise<string[]> {
    await this.initialize();
    return await this.enqueue(async () => {
      const entry = this.entries.find(({ taskId: candidate }) => candidate === taskId);
      if (!entry) return [];
      const results: string[] = [];
      for (const asset of entry.assets) {
        const bytes = await this.storage.readAsset(asset.fileName);
        if (!bytes || bytes.byteLength !== asset.byteLength) throw new Error("回收站图片文件不完整");
        results.push(encodeDataUrl(asset, bytes));
      }
      return results;
    });
  }

  async readPreview(taskId: string): Promise<string | null> {
    await this.initialize();
    return await this.enqueue(async () => {
      const asset = this.entries.find(({ taskId: candidate }) => candidate === taskId)?.assets[0];
      if (!asset) return null;
      const bytes = await this.storage.readAsset(asset.fileName);
      if (!bytes || bytes.byteLength !== asset.byteLength) throw new Error("回收站图片文件不完整");
      return encodeDataUrl(asset, bytes);
    });
  }

  private async setTerminal(taskId: string, status: "failed" | "aborted", error: string) {
    await this.initialize();
    return await this.enqueue(async () => {
      const previousEntries = this.entries;
      let updated: RecycleBinEntry | null = null;
      this.entries = this.entries.map((entry) => {
        if (entry.taskId !== taskId || entry.status !== "pending") return entry;
        updated = { ...entry, status, updatedAt: this.now(), error: error.slice(0, 4_096) };
        return updated;
      });
      if (updated) {
        try {
          await this.persistAndPrune();
        } catch (caught) {
          this.entries = previousEntries;
          this.emit();
          throw caught;
        }
      }
      return updated ? { ...(updated as RecycleBinEntry) } : null;
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async persist() {
    await this.storage.writeIndex({ version: RECYCLE_BIN_VERSION, entries: this.entries });
    this.emit();
  }

  private async persistAndPrune() {
    const { kept, removed } = selectRecycleBinRetention(this.entries);
    this.entries = kept;
    await this.persist();
    await this.deleteAssets(removed.flatMap(({ assets }) => assets));
  }

  private async deleteAssets(assets: RecycleBinAsset[]) {
    await Promise.all(assets.map(({ fileName }) => this.storage.deleteAsset(fileName).catch(() => undefined)));
  }

  private emit() {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}
