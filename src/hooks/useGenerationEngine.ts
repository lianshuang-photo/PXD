import { useMemo } from "react";
import type { AppSettings } from "../context/types";
import {
  createGenerationEngine,
  DEFAULT_GENERATION_ENGINE_FACTORIES,
  type GenerationEngine,
  type GenerationEngineFactories
} from "../services/generationEngine";

export const useGenerationEngine = (
  settings: AppSettings,
  factories: GenerationEngineFactories = DEFAULT_GENERATION_ENGINE_FACTORIES
): GenerationEngine => {
  const isForge = settings.imageProvider === "forge";
  return useMemo(
    () => createGenerationEngine(settings, factories),
    [
      factories,
      settings.imageProvider,
      isForge ? settings.sdEndpoint : undefined,
      isForge ? settings.timeoutMultiplier : undefined,
      isForge ? settings.timeoutMinSeconds : undefined,
      isForge ? settings.timeoutMaxSeconds : undefined,
      isForge ? undefined : settings.geminiEndpoint,
      isForge ? undefined : settings.geminiApiKey,
      isForge ? undefined : settings.geminiModel,
      isForge ? undefined : settings.geminiAuthMode,
      isForge ? undefined : settings.offlineMode
    ]
  );
};
