import { useContext, useMemo } from "react";
import { AppContext } from "../context/AppContext";

export const useAppSettings = () => {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error("useAppSettings must be used within AppProvider");
  }
  const { settings, updateSettings, refreshSettings, saving, loading } = context;

  return useMemo(
    () => ({
      settings,
      refresh: refreshSettings,
      update: updateSettings,
      saving,
      loading
    }),
    [settings, refreshSettings, updateSettings, saving, loading]
  );
};
