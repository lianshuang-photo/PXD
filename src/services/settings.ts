import type { AppSettings } from "../context/types";
import { bridge } from "./uxpBridge";

const SETTINGS_FILE = "settings.json";
const AUTODETECT_CANDIDATES = [
  "http://127.0.0.1:7860",
  "http://localhost:7860",
  "http://127.0.0.1:8000",
  "http://localhost:8000",
  "http://127.0.0.1:8080",
  "http://localhost:8080"
];
const PROBE_TIMEOUT = 3_000;

export const DEFAULT_SETTINGS: AppSettings = {
  sdEndpoint: "http://127.0.0.1:7860",
  offlineMode: true,
  outputDirectory: "",
  brandColor: "#b794f6",
  timeoutMultiplier: 1,
  timeoutMinSeconds: 20,
  timeoutMaxSeconds: 120
};

export const loadSettings = async (): Promise<AppSettings> => {
  const storedPrefs = await bridge.readPreference<AppSettings>(SETTINGS_FILE, DEFAULT_SETTINGS);
  const loaded = await bridge.readJsonFile<AppSettings>(SETTINGS_FILE, DEFAULT_SETTINGS);
  const result = {
    ...DEFAULT_SETTINGS,
    ...loaded,
    ...storedPrefs
  };
  const minSeconds = Number.isFinite(result.timeoutMinSeconds)
    ? Math.max(5, Math.min(result.timeoutMinSeconds, result.timeoutMaxSeconds || DEFAULT_SETTINGS.timeoutMaxSeconds))
    : DEFAULT_SETTINGS.timeoutMinSeconds;
  const maxSeconds = Number.isFinite(result.timeoutMaxSeconds)
    ? Math.max(minSeconds, result.timeoutMaxSeconds)
    : DEFAULT_SETTINGS.timeoutMaxSeconds;
  const multiplier = Number.isFinite(result.timeoutMultiplier) ? Math.max(0.25, result.timeoutMultiplier) : DEFAULT_SETTINGS.timeoutMultiplier;
  return {
    ...result,
    timeoutMinSeconds: minSeconds,
    timeoutMaxSeconds: maxSeconds,
    timeoutMultiplier: multiplier
  };
};

export const saveSettings = async (next: AppSettings): Promise<void> => {
  const minSeconds = Math.max(5, Math.min(next.timeoutMinSeconds, next.timeoutMaxSeconds));
  const maxSeconds = Math.max(minSeconds, next.timeoutMaxSeconds);
  const multiplier = Math.max(0.25, next.timeoutMultiplier);
  const payload: AppSettings = {
    ...next,
    timeoutMinSeconds: minSeconds,
    timeoutMaxSeconds: maxSeconds,
    timeoutMultiplier: multiplier
  };
  await bridge.writePreference<AppSettings>(SETTINGS_FILE, payload);
  await bridge.writeJsonFile<AppSettings>(SETTINGS_FILE, payload);
};

export const openSettingsFolder = async (): Promise<void> => {
  await bridge.revealDataFolder();
};

const toSoftColor = (hex: string, alpha = 0.16) => {
  if (!/^#?[0-9a-f]{6}$/i.test(hex)) return `rgba(60, 131, 246, ${alpha})`;
  const normalized = hex.startsWith("#") ? hex.slice(1) : hex;
  const r = parseInt(normalized.slice(0, 2), 16);
  const g = parseInt(normalized.slice(2, 4), 16);
  const b = parseInt(normalized.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

export const applyBrandColor = (color: string) => {
  if (typeof document === "undefined") return;
  const value = color || DEFAULT_SETTINGS.brandColor;
  document.documentElement.style.setProperty("--brand-color", value);
  document.documentElement.style.setProperty("--brand-color-soft", toSoftColor(value));
  if (document.body) {
    document.body.style.setProperty("--brand-color", value);
    document.body.style.setProperty("--brand-color-soft", toSoftColor(value));
  }
};

const probeEndpoint = async (endpoint: string): Promise<boolean> => {
  try {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), PROBE_TIMEOUT);
    const response = await fetch(`${endpoint.replace(/\/+$/, "")}/sdapi/v1/sd-models`, {
      method: "GET",
      signal: controller.signal
    });
    window.clearTimeout(timeout);
    return response.ok;
  } catch {
    return false;
  }
};

export const autodetectLocalEndpoint = async (): Promise<string | null> => {
  for (const endpoint of AUTODETECT_CANDIDATES) {
    const ok = await probeEndpoint(endpoint);
    if (ok) {
      return endpoint;
    }
  }
  return null;
};
