import { useState } from "react";
import MainPanel from "./panels/MainPanel";
import SettingsPanel from "./panels/SettingsPanel";
import { useAppSettings } from "./hooks/useAppSettings";

type View = "main" | "settings";

const App = () => {
  const [activeView, setActiveView] = useState<View>("main");
  const { settings, refresh, update, saving } = useAppSettings();

  const renderActiveView = () => {
    switch (activeView) {
      case "settings":
        return (
          <SettingsPanel settings={settings} onRefresh={refresh} onUpdate={update} saving={saving} />
        );
      case "main":
      default:
        return <MainPanel settings={settings} onOpenSettings={() => setActiveView("settings")} />;
    }
  };

  return (
    <div className="app-shell">
      <header className="app-shell__header">
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flex: 1, minWidth: 0 }}>
          <h1 className="app-shell__title" style={{ margin: 0, fontSize: "14px", fontWeight: 600, whiteSpace: "nowrap" }}>PXD</h1>
          {activeView === "main" && (
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flex: 1, minWidth: 0, fontSize: "0.75rem" }}>
              <span style={{ whiteSpace: "nowrap" }}>{settings.sdEndpoint ? "已连接" : "未配置"}</span>
              <span style={{ 
                overflow: "hidden", 
                textOverflow: "ellipsis", 
                whiteSpace: "nowrap",
                color: "var(--text-secondary)",
                fontSize: "0.7rem"
              }}>
                {settings.sdEndpoint || ""}
              </span>
            </div>
          )}
        </div>
        <nav className="app-shell__nav">
          <button
            type="button"
            className={activeView === "main" ? "nav-button nav-button--active" : "nav-button"}
            onClick={() => setActiveView("main")}
          >
            主控台
          </button>
          <button
            type="button"
            className={activeView === "settings" ? "nav-button nav-button--active" : "nav-button"}
            onClick={() => setActiveView("settings")}
          >
            设置
          </button>
        </nav>
      </header>
      <main className="app-shell__content">{renderActiveView()}</main>
    </div>
  );
};

export default App;
