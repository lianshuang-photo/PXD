import { useMemo } from "react";
import type { AppSettings } from "../context/types";
import {
  createGenerationEngine,
  DEFAULT_GENERATION_ENGINE_FACTORIES,
  type GenerationEngine,
  type GenerationEngineFactories
} from "../services/generationEngine";

export const generationEngineSettingsKey = (settings: AppSettings) => {
  if (settings.imageProvider === "gemini") {
    return JSON.stringify([
      "gemini",
      settings.geminiEndpoint,
      settings.geminiApiKey,
      settings.geminiModel,
      settings.geminiAuthMode,
      settings.offlineMode
    ]);
  }
  return JSON.stringify([
    "forge",
    settings.sdEndpoint,
    settings.timeoutMultiplier,
    settings.timeoutMinSeconds,
    settings.timeoutMaxSeconds
  ]);
};

export const useGenerationEngine = (
  settings: AppSettings,
  factories: GenerationEngineFactories = DEFAULT_GENERATION_ENGINE_FACTORIES
): GenerationEngine => {
  const settingsKey = generationEngineSettingsKey(settings);
  return useMemo(
    () => createGenerationEngine(settings, factories),
    [factories, settingsKey]
  );
};
