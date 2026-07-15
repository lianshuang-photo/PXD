/* eslint-disable @typescript-eslint/no-explicit-any */
import { bridge } from "./uxpBridge";
import {
  RecycleBinSchemaError,
  isSafeRecycleBinAssetName,
  parseRecycleBinFile,
  type RecycleBinFile
} from "./generationRecycleBin";
import type { GenerationRecycleBinStorage } from "./generationRecycleBinRepository";

const FOLDER_NAME = "recycle-bin";
const ASSET_FOLDER_NAME = "assets";
const INDEX_FILE_NAME = "index.json";

const browserIndexKey = "pxd.recycle-bin.index";
const browserIndexBackupKey = `${browserIndexKey}.bak`;
const browserAssets = new Map<string, Uint8Array>();

const getBrowserStorage = () =>
  typeof window !== "undefined" && typeof window.localStorage !== "undefined" ? window.localStorage : null;

const getFolders = async () => {
  const root = await bridge.getOrCreateFolder(FOLDER_NAME);
  if (!root) return null;
  let assets: any;
  try {
    assets = await root.getEntry(ASSET_FOLDER_NAME);
  } catch {
    assets = await root.createFolder(ASSET_FOLDER_NAME, { overwrite: false });
  }
  return { root, assets };
};

const requireSafeName = (fileName: string) => {
  if (!isSafeRecycleBinAssetName(fileName)) throw new Error("回收站图片路径无效");
};

const toBytes = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new Error("回收站图片读取格式无效");
};

const parseIndexText = (text: string): { parsed: unknown; canonical: RecycleBinFile } => {
  const parsed = JSON.parse(text) as unknown;
  return { parsed, canonical: parseRecycleBinFile(parsed) };
};

const isCanonicalIndexText = (text: string) => {
  const { parsed, canonical } = parseIndexText(text);
  return JSON.stringify(parsed) === JSON.stringify(canonical);
};

const readEntryText = async (folder: any, fileName: string): Promise<string | null> => {
  try {
    const file = await folder.getEntry(fileName);
    return await file.read();
  } catch {
    return null;
  }
};

const writeEntryText = async (folder: any, fileName: string, text: string) => {
  const file = await folder.createFile(fileName, { overwrite: true });
  await file.write(text, { format: bridge.uxp.storage.formats.utf8 });
};

const readWithBackup = async (
  readText: (name: string) => Promise<string | null>,
  repairPrimary: (text: string) => Promise<void>
) => {
  const primary = await readText(INDEX_FILE_NAME);
  if (primary !== null) {
    try {
      return parseIndexText(primary).parsed;
    } catch (error) {
      if (error instanceof RecycleBinSchemaError && error.code === "RECYCLE_BIN_VERSION_UNSUPPORTED") {
        throw error;
      }
      // Fall through to the last-known-good backup.
    }
  }
  const backup = await readText(`${INDEX_FILE_NAME}.bak`);
  if (backup === null) return null;
  const recovered = parseIndexText(backup).parsed;
  await repairPrimary(backup).catch(() => undefined);
  return recovered;
};

const writeWithLastKnownGood = async (
  payload: RecycleBinFile,
  readText: (name: string) => Promise<string | null>,
  writeText: (name: string, text: string) => Promise<void>
) => {
  const serialized = JSON.stringify(payload, null, 2);
  const primary = await readText(INDEX_FILE_NAME);
  let previousGood: string | null = null;
  if (primary !== null) {
    try {
      if (isCanonicalIndexText(primary)) previousGood = primary;
    } catch (error) {
      if (error instanceof RecycleBinSchemaError && error.code === "RECYCLE_BIN_VERSION_UNSUPPORTED") {
        throw error;
      }
      // Preserve the existing backup when the primary is already damaged.
    }
  }
  if (previousGood !== null) {
    await writeText(`${INDEX_FILE_NAME}.bak`, previousGood);
  } else {
    const backup = await readText(`${INDEX_FILE_NAME}.bak`);
    let backupIsCanonical = false;
    if (backup !== null) {
      try {
        backupIsCanonical = isCanonicalIndexText(backup);
      } catch (error) {
        if (error instanceof RecycleBinSchemaError && error.code === "RECYCLE_BIN_VERSION_UNSUPPORTED") {
          throw error;
        }
      }
    }
    // A legacy/non-canonical index may contain fields that the current schema strips. Never
    // rotate those bytes into previous-good storage; make the canonical payload durable first.
    if (!backupIsCanonical) await writeText(`${INDEX_FILE_NAME}.bak`, serialized);
  }
  await writeText(INDEX_FILE_NAME, serialized);
};

export const createGenerationRecycleBinStorage = (): GenerationRecycleBinStorage => ({
  async readIndex() {
    if (!bridge.uxp) {
      const storage = getBrowserStorage();
      return await readWithBackup(
        async (name) => storage?.getItem(name === INDEX_FILE_NAME ? browserIndexKey : browserIndexBackupKey) ?? null,
        async (text) => { storage?.setItem(browserIndexKey, text); }
      );
    }
    const folders = await getFolders();
    return folders ? await readWithBackup(
      (name) => readEntryText(folders.root, name),
      (text) => writeEntryText(folders.root, INDEX_FILE_NAME, text)
    ) : null;
  },
  async writeIndex(payload: RecycleBinFile) {
    if (!bridge.uxp) {
      const storage = getBrowserStorage();
      await writeWithLastKnownGood(
        payload,
        async (name) => storage?.getItem(name === INDEX_FILE_NAME ? browserIndexKey : browserIndexBackupKey) ?? null,
        async (name, text) => { storage?.setItem(name === INDEX_FILE_NAME ? browserIndexKey : browserIndexBackupKey, text); }
      );
      return;
    }
    const folders = await getFolders();
    if (!folders) throw new Error("回收站目录不可用");
    await writeWithLastKnownGood(
      payload,
      (name) => readEntryText(folders.root, name),
      (name, text) => writeEntryText(folders.root, name, text)
    );
  },
  async writeAsset(fileName: string, bytes: Uint8Array) {
    requireSafeName(fileName);
    if (!bridge.uxp) {
      browserAssets.set(fileName, bytes.slice());
      return;
    }
    const folders = await getFolders();
    if (!folders) throw new Error("回收站目录不可用");
    const file = await folders.assets.createFile(fileName, { overwrite: true });
    await file.write(bytes, { format: bridge.uxp.storage.formats.binary });
  },
  async readAsset(fileName: string) {
    requireSafeName(fileName);
    if (!bridge.uxp) return browserAssets.get(fileName)?.slice() ?? null;
    try {
      const folders = await getFolders();
      if (!folders) return null;
      const file = await folders.assets.getEntry(fileName);
      return toBytes(await file.read({ format: bridge.uxp.storage.formats.binary }));
    } catch {
      return null;
    }
  },
  async deleteAsset(fileName: string) {
    requireSafeName(fileName);
    if (!bridge.uxp) {
      browserAssets.delete(fileName);
      return;
    }
    try {
      const folders = await getFolders();
      const entry = await folders?.assets.getEntry(fileName);
      await entry?.delete();
    } catch {
      // Missing files are already deleted.
    }
  },
  async listAssets() {
    if (!bridge.uxp) return Array.from(browserAssets.keys());
    const folders = await getFolders();
    if (!folders || typeof folders.assets.getEntries !== "function") return [];
    const entries = await folders.assets.getEntries();
    return entries.map((entry: any) => entry.name).filter(isSafeRecycleBinAssetName);
  }
});
