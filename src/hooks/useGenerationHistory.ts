import { useCallback, useEffect, useRef, useState } from "react";
import {
  createGenerationHistoryEntry,
  createGenerationThumbnail,
  loadGenerationHistory,
  prependGenerationHistory,
  saveGenerationHistory,
  type GenerationHistoryEntry
} from "../services/generationHistory";
import type { AppSettings } from "../context/types";

interface RecordGenerationHistoryInput<TParams> {
  provider: AppSettings["imageProvider"];
  prompt: string;
  params: TParams;
  resultDataUrl: string;
}

const historyErrorMessage = (action: string, caught: unknown) => {
  const detail = caught instanceof Error ? caught.message : "未知错误";
  return `生成历史${action}失败：${detail}`;
};

export const useGenerationHistory = <TParams>(onWarning: (message: string) => void) => {
  const [entries, setEntries] = useState<GenerationHistoryEntry<TParams>[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const entriesRef = useRef<GenerationHistoryEntry<TParams>[]>([]);
  const loadPromiseRef = useRef<Promise<GenerationHistoryEntry<TParams>[]> | null>(null);
  const writeChainRef = useRef<Promise<void>>(Promise.resolve());
  const mountedRef = useRef(true);
  const warningRef = useRef(onWarning);
  warningRef.current = onWarning;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (!loadPromiseRef.current) {
      loadPromiseRef.current = loadGenerationHistory<TParams>()
        .then((loaded) => {
          entriesRef.current = loaded;
          if (mountedRef.current) {
            setEntries(loaded);
            setError(null);
          }
          return loaded;
        })
        .catch((caught) => {
          const message = historyErrorMessage("加载", caught);
          if (mountedRef.current) setError(message);
          warningRef.current(message);
          return entriesRef.current;
        })
        .finally(() => {
          if (mountedRef.current) setLoading(false);
        });
    }
    return await loadPromiseRef.current;
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const record = useCallback(async (input: RecordGenerationHistoryInput<TParams>) => {
    await load();
    let thumbnailDataUrl: string;
    try {
      thumbnailDataUrl = await createGenerationThumbnail(input.resultDataUrl);
    } catch (caught) {
      const message = historyErrorMessage("缩略图创建", caught);
      if (mountedRef.current) setError(message);
      warningRef.current(message);
      return null;
    }

    const entry = createGenerationHistoryEntry({
      provider: input.provider,
      prompt: input.prompt,
      params: input.params,
      thumbnailDataUrl
    });
    const next = prependGenerationHistory(entriesRef.current, entry);
    entriesRef.current = next;
    if (mountedRef.current) {
      setEntries(next);
      setError(null);
    }

    const write = writeChainRef.current
      .catch(() => undefined)
      .then(() => saveGenerationHistory(next));
    writeChainRef.current = write;
    try {
      await write;
      return entry;
    } catch (caught) {
      const message = historyErrorMessage("保存", caught);
      if (mountedRef.current) setError(message);
      warningRef.current(message);
      return null;
    }
  }, [load]);

  return { entries, loading, error, record, reload: load };
};
