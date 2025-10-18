import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { AppContext } from "./AppContext";
import type { AppSettings } from "./types";
import { DEFAULT_SETTINGS, applyBrandColor, loadSettings, saveSettings } from "../services/settings";

interface Props {
  children: ReactNode;
}

export const AppProvider = ({ children }: Props) => {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [saving, setSaving] = useState(false);

  const refreshSettings = useCallback(async () => {
    const next = await loadSettings();
    setSettings(next);
    applyBrandColor(next.brandColor);
  }, []);

  useEffect(() => {
    refreshSettings().catch((error) => {
      console.error("Failed to load settings on boot", error);
    });
  }, [refreshSettings]);

  useEffect(() => {
    applyBrandColor(settings.brandColor);
  }, [settings.brandColor]);

  const updateSettings = useCallback(async (next: Partial<AppSettings>) => {
    setSaving(true);
    try {
      const merged: AppSettings = { ...settings, ...next };
      await saveSettings(merged);
      setSettings(merged);
      applyBrandColor(merged.brandColor);
    } finally {
      setSaving(false);
    }
  }, [settings]);

  const value = useMemo(
    () => ({
      settings,
      updateSettings,
      refreshSettings,
      saving
    }),
    [settings, updateSettings, refreshSettings, saving]
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
};
