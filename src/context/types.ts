export interface AppSettings {
  sdEndpoint: string;
  imageProvider: "forge" | "gemini";
  geminiEndpoint: string;
  geminiApiKey: string;
  geminiModel: string;
  geminiAuthMode: "queryKey" | "bearer";
  offlineMode: boolean;
  brandColor: string;
  timeoutMultiplier: number;
  timeoutMinSeconds: number;
  timeoutMaxSeconds: number;
  maxConcurrentTasks: number;
}

export interface AppContextValue {
  settings: AppSettings;
  updateSettings: (next: Partial<AppSettings>) => Promise<void>;
  refreshSettings: () => Promise<void>;
  saving: boolean;
  loading: boolean;
}
