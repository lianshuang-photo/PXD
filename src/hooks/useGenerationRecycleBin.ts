import { useCallback, useEffect, useRef, useState } from "react";
import type { RecycleBinEntry, RecycleBinTaskInput } from "../services/generationRecycleBin";
import { GenerationRecycleBinRepository } from "../services/generationRecycleBinRepository";
import { createGenerationRecycleBinStorage } from "../services/generationRecycleBinStorage";

export interface GenerationRecycleBinState {
  entries: RecycleBinEntry[];
  loading: boolean;
  error: string | null;
  begin: (input: RecycleBinTaskInput) => Promise<RecycleBinEntry>;
  complete: (taskId: string, images: string[]) => Promise<RecycleBinEntry | null>;
  fail: (taskId: string, error: unknown) => Promise<RecycleBinEntry | null>;
  abort: (taskId: string, reason?: string) => Promise<RecycleBinEntry | null>;
  readImages: (taskId: string) => Promise<string[]>;
  readPreview: (taskId: string) => Promise<string | null>;
}

const messageFor = (caught: unknown) =>
  caught instanceof Error ? caught.message : "生成回收站不可用";

export const useGenerationRecycleBin = (
  suppliedRepository?: GenerationRecycleBinRepository
): GenerationRecycleBinState => {
  const repositoryRef = useRef<GenerationRecycleBinRepository | null>(null);
  if (!repositoryRef.current) {
    repositoryRef.current = suppliedRepository ?? new GenerationRecycleBinRepository(
      createGenerationRecycleBinStorage()
    );
  }
  const repository = repositoryRef.current;
  const [entries, setEntries] = useState<RecycleBinEntry[]>(repository.getSnapshot());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => repository.subscribe(setEntries), [repository]);
  useEffect(() => {
    let current = true;
    void repository.initialize()
      .then(() => {
        if (current) setError(null);
      })
      .catch((caught) => {
        if (current) setError(messageFor(caught));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [repository]);

  const run = useCallback(async <T,>(operation: () => Promise<T>): Promise<T> => {
    try {
      const result = await operation();
      setError(null);
      return result;
    } catch (caught) {
      setError(messageFor(caught));
      throw caught;
    }
  }, []);

  return {
    entries,
    loading,
    error,
    begin: useCallback((input) => run(() => repository.begin(input)), [repository, run]),
    complete: useCallback((taskId, images) => run(() => repository.complete(taskId, images)), [repository, run]),
    fail: useCallback((taskId, caught) => run(() => repository.fail(taskId, caught)), [repository, run]),
    abort: useCallback((taskId, reason) => run(() => repository.abort(taskId, reason)), [repository, run]),
    readImages: useCallback((taskId) => run(() => repository.readImages(taskId)), [repository, run]),
    readPreview: useCallback((taskId) => run(() => repository.readPreview(taskId)), [repository, run])
  };
};
