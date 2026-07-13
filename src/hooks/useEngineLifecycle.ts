import { useCallback, useLayoutEffect, useRef } from "react";
import type { GenerationEngine } from "../services/generationEngine";

export interface EngineGenerationToken {
  engine: GenerationEngine;
  generation: number;
}

export const useEngineLifecycle = (engine: GenerationEngine) => {
  const tokenRef = useRef<EngineGenerationToken>({ engine, generation: 0 });
  const pollingRef = useRef<{
    interval: ReturnType<typeof setInterval>;
    token: EngineGenerationToken;
  } | null>(null);

  if (tokenRef.current.engine !== engine) {
    tokenRef.current = {
      engine,
      generation: tokenRef.current.generation + 1
    };
  }
  const token = tokenRef.current;

  const stopPolling = useCallback((candidate?: EngineGenerationToken) => {
    if (pollingRef.current && (!candidate || pollingRef.current.token === candidate)) {
      clearInterval(pollingRef.current.interval);
      pollingRef.current = null;
    }
  }, []);

  const isCurrent = useCallback(
    (candidate: EngineGenerationToken) => tokenRef.current === candidate,
    []
  );

  const commitIfCurrent = useCallback(
    (candidate: EngineGenerationToken, commit: () => void) => {
      if (!isCurrent(candidate)) return false;
      commit();
      return true;
    },
    [isCurrent]
  );

  const startPolling = useCallback(
    (candidate: EngineGenerationToken, onProgress: (progress: number) => void) => {
      const fetchProgress = candidate.engine.fetchProgress;
      if (!fetchProgress || !isCurrent(candidate)) return;
      stopPolling();
      let inFlight = false;
      const interval = setInterval(async () => {
        if (!isCurrent(candidate)) {
          stopPolling();
          return;
        }
        if (inFlight) return;
        inFlight = true;
        try {
          const progressInfo = await fetchProgress();
          if (progressInfo && typeof progressInfo.progress === "number") {
            commitIfCurrent(candidate, () => onProgress(progressInfo.progress));
          }
        } catch {
          // Progress is best-effort; generation errors are reported by the main request.
        } finally {
          inFlight = false;
        }
      }, 1_000);
      pollingRef.current = { interval, token: candidate };
    },
    [commitIfCurrent, isCurrent, stopPolling]
  );

  useLayoutEffect(() => {
    stopPolling();
    return () => stopPolling();
  }, [engine, stopPolling]);

  return {
    token,
    isCurrent,
    commitIfCurrent,
    startPolling,
    stopPolling
  };
};
