import { useEffect, useState } from "react";
import type { AppSettings } from "../context/types";
import { openSettingsFolder } from "../services/settings";
import { openPresetFolder } from "../services/presets";

interface Props {
  settings: AppSettings;
  onUpdate: (next: Partial<AppSettings>) => Promise<void>;
  onRefresh: () => Promise<void>;
  saving: boolean;
}

const SettingsPanel = ({ settings, onUpdate, onRefresh, saving }: Props) => {
  const [form, setForm] = useState<AppSettings>(settings);
  const [message, setMessage] = useState<string | null>(null);
  const [pingResult, setPingResult] = useState<"idle" | "success" | "error">("idle");

  useEffect(() => {
    setForm(settings);
  }, [settings]);

  const handleSave = async () => {
    setMessage(null);
    try {
      await onUpdate(form);
      setMessage("设置已保存");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存失败");
    }
  };

  const handlePing = async () => {
    setPingResult("idle");
    try {
      const response = await fetch(`${form.sdEndpoint.replace(/\/+$/, "")}/sdapi/v1/sd-models`, {
        method: "GET"
      });
      setPingResult(response.ok ? "success" : "error");
    } catch (error) {
      console.warn("Ping endpoint failed", error);
      setPingResult("error");
    }
  };

  const handleOpenDataFolder = async () => {
    try {
      await openSettingsFolder();
    } catch (error) {
      console.warn("Open data folder failed", error);
      setMessage("无法打开数据目录，请手动定位到插件数据目录。");
    }
  };

  const handleOpenPresetFolder = async () => {
    try {
      await openPresetFolder();
    } catch (error) {
      console.warn("Open preset folder failed", error);
      setMessage("无法打开预设目录，请手动定位到插件数据目录下的 presets 文件夹。");
    }
  };

  return (
    <section className="panel panel--settings">
      <header className="panel__header">
        <div>
          <h2 className="panel__title">面板设置</h2>
          <p className="panel__subtitle">控制算力来源与基础体验参数。</p>
        </div>
        <div className="panel__actions">
          <button type="button" className="btn btn--ghost" onClick={onRefresh} disabled={saving}>
            重新加载
          </button>
          <button type="button" className="btn btn--ghost" onClick={handleOpenDataFolder}>
            打开数据目录
          </button>
          <button type="button" className="btn btn--ghost" onClick={handleOpenPresetFolder}>
            打开预设目录
          </button>
        </div>
      </header>

      <div className="panel__body">
        <label className="form-field">
          <span className="form-field__label">Stable Diffusion 服务地址</span>
          <input
            className="input"
            type="text"
            value={form.sdEndpoint}
            onChange={(event) => setForm((prev) => ({ ...prev, sdEndpoint: event.target.value }))}
            placeholder="http://127.0.0.1:7860"
          />
          <small className="form-field__hint">
            面板将直接连接本地或私有服务器，无需账号登录。
          </small>
        </label>

        <label className="form-field form-field--row">
          <span className="form-field__label">离线模式</span>
          <input
            type="checkbox"
            checked={form.offlineMode}
            onChange={(event) => setForm((prev) => ({ ...prev, offlineMode: event.target.checked }))}
          />
          <span className="form-field__hint">开启后禁用远程请求，仅使用本地算力。</span>
        </label>

        <div style={{ display: "flex", gap: "0.12rem", marginBottom: "0.12rem" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.12rem", flex: 1, minWidth: 0 }}>
            <span style={{ fontSize: "0.85rem", lineHeight: 1.3, color: "var(--text-secondary)", flexShrink: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: "1.5rem" }}>超时倍率</span>
            <input
              className="input"
              type="number"
              min={0.25}
              step={0.1}
              value={form.timeoutMultiplier}
              onChange={(event) => {
                const value = Number.parseFloat(event.target.value);
                setForm((prev) => ({
                  ...prev,
                  timeoutMultiplier: Number.isFinite(value) ? Math.max(0.25, value) : prev.timeoutMultiplier
                }));
              }}
              placeholder="放大延长等待"
              style={{ flex: 1, minWidth: 0 }}
            />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "0.12rem", flex: 1, minWidth: 0 }}>
            <span style={{ fontSize: "0.85rem", lineHeight: 1.3, color: "var(--text-secondary)", flexShrink: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: "1.5rem" }}>最短(秒)</span>
            <input
              className="input"
              type="number"
              min={5}
              step={1}
              value={form.timeoutMinSeconds}
              onChange={(event) => {
                const value = Number.parseFloat(event.target.value);
                setForm((prev) => {
                  if (!Number.isFinite(value)) return prev;
                  const minSeconds = Math.max(5, value);
                  return {
                    ...prev,
                    timeoutMinSeconds: minSeconds,
                    timeoutMaxSeconds: Math.max(minSeconds, prev.timeoutMaxSeconds)
                  };
                });
              }}
              placeholder="慢设备容错"
              style={{ flex: 1, minWidth: 0 }}
            />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "0.12rem", flex: 1, minWidth: 0 }}>
            <span style={{ fontSize: "0.85rem", lineHeight: 1.3, color: "var(--text-secondary)", flexShrink: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: "1.5rem" }}>最长(秒)</span>
            <input
              className="input"
              type="number"
              min={10}
              step={5}
              value={form.timeoutMaxSeconds}
              onChange={(event) => {
                const value = Number.parseFloat(event.target.value);
                setForm((prev) => {
                  if (!Number.isFinite(value)) return prev;
                  const maxSeconds = Math.max(prev.timeoutMinSeconds, value);
                  return {
                    ...prev,
                    timeoutMaxSeconds: maxSeconds
                  };
                });
              }}
              placeholder="防止无限等待"
              style={{ flex: 1, minWidth: 0 }}
            />
          </div>
        </div>

        <label className="form-field">
          <span className="form-field__label">输出目录</span>
          <input
            className="input"
            type="text"
            value={form.outputDirectory}
            onChange={(event) =>
              setForm((prev) => ({ ...prev, outputDirectory: event.target.value }))
            }
            placeholder="留空则使用 Photoshop 文档目录"
          />
        </label>

        <label className="form-field">
          <span className="form-field__label">品牌色</span>
          <input
            className="input"
            type="color"
            value={form.brandColor}
            onChange={(event) => setForm((prev) => ({ ...prev, brandColor: event.target.value }))}
          />
        </label>

        <div className="panel__actions">
          <button type="button" className="btn btn--secondary" onClick={handlePing}>
            测试连接
          </button>
          <button type="button" className="btn btn--primary" disabled={saving} onClick={handleSave}>
            {saving ? "保存中…" : "保存设置"}
          </button>
        </div>

        {message && <div className="alert alert--info">{message}</div>}
        {pingResult === "success" && <div className="alert alert--success">连接成功</div>}
        {pingResult === "error" && <div className="alert alert--error">无法连接到算力端</div>}
      </div>
    </section>
  );
};

export default SettingsPanel;
