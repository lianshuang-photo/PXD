export interface TextFileStorage {
  readText: (fileName: string) => Promise<string | null>;
  writeText: (fileName: string, content: string) => Promise<void>;
}

export interface AtomicJsonReadEvents {
  onPrimaryError?: (error: unknown) => void;
  onBackupError?: (error: unknown) => void;
  onRepairError?: (error: unknown) => void;
}

export const jsonBackupFileName = (fileName: string): string => `${fileName}.bak`;

const parseJson = <T>(text: string | null, fileName: string): T => {
  if (text === null) {
    throw new Error(`${fileName} does not exist`);
  }
  return JSON.parse(text) as T;
};

export const readAtomicJson = async <T>(
  storage: TextFileStorage,
  fileName: string,
  fallback: T,
  events: AtomicJsonReadEvents = {}
): Promise<T> => {
  try {
    return parseJson<T>(await storage.readText(fileName), fileName);
  } catch (error) {
    events.onPrimaryError?.(error);
  }

  const backupFileName = jsonBackupFileName(fileName);
  try {
    const backupText = await storage.readText(backupFileName);
    const recovered = parseJson<T>(backupText, backupFileName);

    // A valid backup remains authoritative even if repairing the primary file fails.
    try {
      await storage.writeText(fileName, backupText as string);
    } catch (error) {
      events.onRepairError?.(error);
    }
    return recovered;
  } catch (error) {
    events.onBackupError?.(error);
    return fallback;
  }
};

export const writeAtomicJson = async <T>(
  storage: TextFileStorage,
  fileName: string,
  payload: T
): Promise<void> => {
  const serialized = JSON.stringify(payload, null, 2);
  await storage.writeText(jsonBackupFileName(fileName), serialized);
  await storage.writeText(fileName, serialized);
};
