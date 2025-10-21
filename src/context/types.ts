export interface AppSettings {
  sdEndpoint: string;
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
}
