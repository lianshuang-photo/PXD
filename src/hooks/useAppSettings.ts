import { useContext, useMemo } from "react";
import { AppContext } from "../context/AppContext";

export const useAppSettings = () => {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error("useAppSettings must be used within AppProvider");
  }
  const { settings, updateSettings, refreshSettings, saving } = context;

  return useMemo(
    () => ({
      settings,
      refresh: refreshSettings,
      update: updateSettings,
      saving
    }),
    [settings, refreshSettings, updateSettings, saving]
  );
};
