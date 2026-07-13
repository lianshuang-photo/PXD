export interface AppSettings {
  sdEndpoint: string;
  imageProvider: "forge" | "gemini";
  geminiEndpoint: string;
  geminiApiKey: string;
  geminiModel: string;
  geminiAuthMode: "queryKey" | "bearer";
  offlineMode: boolean;
  outputDirectory: string;
  brandColor: string;
  timeoutMultiplier: number;
  timeoutMinSeconds: number;
  timeoutMaxSeconds: number;
}

export interface AppContextValue {
  settings: AppSettings;
  updateSettings: (next: Partial<AppSettings>) => Promise<void>;
  refreshSettings: () => Promise<void>;
  saving: boolean;
  loading: boolean;
}
