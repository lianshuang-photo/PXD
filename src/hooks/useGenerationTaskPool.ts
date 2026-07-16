import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  GenerationTaskPool,
  type GenerationTaskDefinition,
  type GenerationTaskSnapshot
} from "../services/generationTaskPool";

export const useGenerationTaskPool = (concurrency: number) => {
  const poolRef = useRef<GenerationTaskPool | null>(null);
  if (!poolRef.current) {
    poolRef.current = new GenerationTaskPool({ concurrency });
  }
  const pool = poolRef.current;
  const [taskMap, setTaskMap] = useState<Record<string, GenerationTaskSnapshot>>({});

  useEffect(() => pool.subscribe(setTaskMap), [pool]);

  useEffect(() => {
    pool.setConcurrency(concurrency);
  }, [concurrency, pool]);

  useEffect(() => () => {
    void pool.dispose();
  }, [pool]);

  const tasks = useMemo(
    () => Object.values(taskMap).sort((left, right) => right.createdAt - left.createdAt),
    [taskMap]
  );

  return {
    tasks,
    taskMap,
    concurrency: pool.limit,
    enqueueTask: useCallback((definition: GenerationTaskDefinition) => pool.enqueue(definition), [pool]),
    cancelTask: useCallback((id: string) => pool.cancel(id), [pool]),
    retryTask: useCallback((id: string) => pool.retry(id), [pool]),
    cleanupTask: useCallback((id: string) => pool.cleanup(id), [pool]),
    returnTask: useCallback((id: string) => pool.returnTask(id), [pool]),
    removeTask: useCallback((id: string) => pool.remove(id), [pool]),
    extendTask: useCallback((id: string, seconds = 10) => pool.extend(id, seconds), [pool]),
    setTaskAutoReturn: useCallback((id: string, autoReturn: boolean) => pool.setAutoReturn(id, autoReturn), [pool])
  };
};
