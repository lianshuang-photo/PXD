import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppContext } from "./AppContext";
import type { AppSettings } from "./types";
import { DEFAULT_SETTINGS, applyBrandColor, loadSettings, saveSettings } from "../services/settings";
import { LatestLoadGate } from "../services/loadGate";

interface Props {
  children: ReactNode;
}

export const AppProvider = ({ children }: Props) => {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const loadGateRef = useRef(new LatestLoadGate());
  const settingsRef = useRef(DEFAULT_SETTINGS);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingSavesRef = useRef(0);

  const refreshSettings = useCallback(async () => {
    const gate = loadGateRef.current;
    const generation = gate.begin();
    setLoading(true);
    try {
      const next = await loadSettings();
      if (!gate.isCurrent(generation)) {
        return;
      }
      settingsRef.current = next;
      setSettings(next);
      applyBrandColor(next.brandColor);
    } finally {
      if (gate.complete(generation)) {
        setLoading(false);
      }
    }
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
    loadGateRef.current.assertReady("设置仍在加载，请稍后重试");
    pendingSavesRef.current += 1;
    setSaving(true);
    const save = saveQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        const merged: AppSettings = { ...settingsRef.current, ...next };
        await saveSettings(merged);
        settingsRef.current = merged;
        setSettings(merged);
        applyBrandColor(merged.brandColor);
      });
    saveQueueRef.current = save;
    try {
      await save;
    } finally {
      pendingSavesRef.current -= 1;
      if (pendingSavesRef.current === 0) setSaving(false);
    }
  }, []);

  const value = useMemo(
    () => ({
      settings,
      updateSettings,
      refreshSettings,
      saving,
      loading
    }),
    [settings, updateSettings, refreshSettings, saving, loading]
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
};
