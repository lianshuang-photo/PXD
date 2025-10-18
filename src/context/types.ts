export interface AppSettings {
  sdEndpoint: string;
  offlineMode: boolean;
  outputDirectory: string;
  brandColor: string;
}

export interface AppContextValue {
  settings: AppSettings;
  updateSettings: (next: Partial<AppSettings>) => Promise<void>;
  refreshSettings: () => Promise<void>;
  saving: boolean;
}
