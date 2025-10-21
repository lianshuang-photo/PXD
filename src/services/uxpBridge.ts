/* eslint-disable @typescript-eslint/no-explicit-any */
const resolveUxpModule = <T = any>(moduleId: string): T | undefined => {
  try {
    if (typeof window !== "undefined" && typeof (window as any).require === "function") {
      return (window as any).require(moduleId) as T;
    }
  } catch (error) {
    console.error(`Failed to resolve UXP module ${moduleId}`, error);
  }
  return undefined;
};

const uxp = resolveUxpModule<any>("uxp");
const photoshop = resolveUxpModule<any>("photoshop");

// 浏览器环境模拟存储
const isBrowserMode = !uxp;
const browserStorage: Map<string, string> = new Map();
const browserPersist: Storage | null =
  typeof window !== "undefined" && typeof window.localStorage !== "undefined"
    ? window.localStorage
    : null;

const dataFolderName = "pxd-data";

const ensureDataFolder = async () => {
  if (!uxp) {
    return undefined;
  }
  const { localFileSystem } = uxp.storage;
  if (!ensureDataFolder.cachePromise) {
    ensureDataFolder.cachePromise = localFileSystem.getDataFolder().then(async (folder: any) => {
      try {
        return await folder.getEntry(dataFolderName);
      } catch {
        return await folder.createFolder(dataFolderName, { overwrite: false });
      }
    });
  }
  return ensureDataFolder.cachePromise;
};
ensureDataFolder.cachePromise = undefined as Promise<any> | undefined;

const resolvePersistentStorage = () => {
  if (uxp?.storage?.localStorage) {
    return uxp.storage.localStorage;
  }
  return browserPersist;
};

const pathToFileUrl = (path: string) => {
  if (!path) return "";
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const encoded = normalized
    .split("/")
    .map((segment, index) => {
      if (index === 0 && segment === "") {
        return "";
      }
      return encodeURIComponent(segment);
    })
    .join("/");
  return `file://${encoded.startsWith("/") ? encoded : `/${encoded}`}`;
};

const toNativePath = (entry: any): string | null => {
  if (!entry) {
    return null;
  }
  if (typeof entry.nativePath === "string") {
    return entry.nativePath;
  }
  if (typeof entry.nativeFsPath === "string") {
    return entry.nativeFsPath;
  }
  if (typeof entry.url === "string") {
    if (entry.url.startsWith("file://")) {
      try {
        return decodeURIComponent(entry.url.replace(/^file:\/\//, ""));
      } catch {
        return entry.url;
      }
    }
    return entry.url;
  }
  return null;
};

const tryOpenDirectoryViaShell = async (nativePath: string) => {
  if (!nativePath || !uxp?.shell || typeof uxp.shell.openPath !== "function") {
    return false;
  }
  const pathType = uxp.shell.PathType ?? {};
  const rawCandidates = [
    pathType.DIRECTORY,
    pathType.FOLDER,
    pathType.Folder,
    pathType.Directory,
    "directory",
    "folder"
  ].filter((value) => typeof value === "string" && value.length > 0);
  const seen = new Set<string>();
  const candidates: Record<string, unknown>[] = [];
  for (const value of rawCandidates) {
    if (!seen.has(value)) {
      seen.add(value);
      candidates.push({ pathType: value });
    }
  }
  candidates.push({});
  for (const options of candidates) {
    try {
      await uxp.shell.openPath(nativePath, options);
      return true;
    } catch (error) {
      console.warn(`openPath failed for ${nativePath}`, error);
    }
  }
  return false;
};

const revealEntryImpl = async (entry: any): Promise<void> => {
  if (!entry || !uxp) {
    throw new Error("Entry is not available");
  }
  const revealViaFs = uxp.storage?.localFileSystem;
  if (revealViaFs && typeof revealViaFs.reveal === "function") {
    try {
      await revealViaFs.reveal(entry);
      return;
    } catch (error) {
      console.warn("localFileSystem.reveal failed", error);
    }
  }
  if (typeof entry.reveal === "function") {
    try {
      await entry.reveal();
      return;
    } catch (error) {
      console.warn("entry.reveal failed", error);
    }
  }
  const nativePath = toNativePath(entry);
  if (nativePath) {
    const opened = await tryOpenDirectoryViaShell(nativePath);
    if (opened) {
      return;
    }
    if (uxp.shell?.openExternal) {
      const fileUrl = pathToFileUrl(nativePath);
      if (fileUrl) {
        try {
          await uxp.shell.openExternal(fileUrl);
          return;
        } catch (error) {
          console.warn(`openExternal failed for ${fileUrl}`, error);
        }
      }
    }
  }
  throw new Error("Reveal is not supported for this entry");
};

export const bridge = {
  photoshop,
  uxp,
  async getDataFolder() {
    return await ensureDataFolder();
  },
  async getOrCreateFolder(folderName: string) {
    const root = await ensureDataFolder();
    if (!root) return undefined;
    try {
      return await root.getEntry(folderName);
    } catch {
      return await root.createFolder(folderName, { overwrite: false });
    }
  },
  async getTemporaryFolder() {
    if (!uxp) return undefined;
    return await uxp.storage.localFileSystem.getTemporaryFolder();
  },
  async readFile(fileName: string): Promise<string | null> {
    if (isBrowserMode) {
      return browserStorage.get(fileName) || null;
    }
    try {
      const folder = await ensureDataFolder();
      if (!folder) return null;
      const file = await folder.getEntry(fileName);
      return await file.read();
    } catch (error) {
      console.warn(`readFile fallback triggered for ${fileName}`, error);
      return null;
    }
  },
  async writeFile(fileName: string, content: string, options: Record<string, unknown> = {}) {
    if (isBrowserMode) {
      browserStorage.set(fileName, content);
      return;
    }
    const folder = await ensureDataFolder();
    if (!folder) return;
    const file = await folder.createFile(fileName, { overwrite: true });
    await file.write(content, options);
  },
  async writeBinaryFile(fileName: string, buffer: Uint8Array) {
    if (!uxp) return;
    const folder = await ensureDataFolder();
    if (!folder) return;
    const file = await folder.createFile(fileName, { overwrite: true });
    await file.write(buffer, { format: uxp.storage.formats.binary });
  },
  async createSessionToken(entry: any) {
    if (!uxp) return undefined;
    return await uxp.storage.localFileSystem.createSessionToken(entry);
  },
  async readJsonFile<T>(fileName: string, fallback: T): Promise<T> {
    if (isBrowserMode) {
      const stored = browserStorage.get(fileName);
      if (stored) {
        try {
          return JSON.parse(stored) as T;
        } catch {
          return fallback;
        }
      }
      return fallback;
    }
    try {
      const folder = await ensureDataFolder();
      if (!folder) return fallback;
      const file = await folder.getEntry(fileName);
      const text = await file.read();
      return JSON.parse(text) as T;
    } catch (error) {
      console.warn(`readJsonFile fallback triggered for ${fileName}`, error);
      return fallback;
    }
  },
  async writeJsonFile<T>(fileName: string, payload: T): Promise<void> {
    if (isBrowserMode) {
      browserStorage.set(fileName, JSON.stringify(payload, null, 2));
      return;
    }
    try {
      const folder = await ensureDataFolder();
      if (!folder || !uxp) return;
      const file = await folder.createFile(fileName, { overwrite: true });
      await file.write(JSON.stringify(payload, null, 2), { format: uxp.storage.formats.utf8 });
    } catch (error) {
      console.error(`writeJsonFile failed for ${fileName}`, error);
      throw error;
    }
  },
  async readPreference<T>(key: string, fallback: T): Promise<T> {
    const store = resolvePersistentStorage();
    if (!store) return fallback;
    try {
      const value = store.getItem(key);
      if (value == null) return fallback;
      const parsed = JSON.parse(value) as T;
      return parsed;
    } catch (error) {
      console.warn(`readPreference fallback triggered for ${key}`, error);
      return fallback;
    }
  },
  async writePreference<T>(key: string, payload: T): Promise<void> {
    const store = resolvePersistentStorage();
    if (!store) return;
    try {
      const serialized = JSON.stringify(payload);
      store.setItem(key, serialized);
    } catch (error) {
      console.warn(`writePreference failed for ${key}`, error);
    }
  },
  async getEntryFromUrl(url: string) {
    if (!uxp) return undefined;
    try {
      return await uxp.storage.localFileSystem.getEntryWithUrl(url);
    } catch (error) {
      console.error(`Failed to get entry for url ${url}`, error);
      return undefined;
    }
  },
  async revealEntry(entry: any): Promise<void> {
    try {
      await revealEntryImpl(entry);
    } catch (error) {
      console.error("Failed to reveal entry", error);
      throw error;
    }
  },
  async revealDataFolder(): Promise<void> {
    try {
      const folder = await ensureDataFolder();
      if (!folder) {
        throw new Error("Data folder is unavailable");
      }
      await revealEntryImpl(folder);
    } catch (error) {
      console.error("Failed to reveal data folder", error);
      throw error;
    }
  }
};

export type Bridge = typeof bridge;
