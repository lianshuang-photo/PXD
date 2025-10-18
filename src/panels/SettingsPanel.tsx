import { useEffect, useState } from "react";
import type { AppSettings } from "../context/types";
import { autodetectLocalEndpoint, openSettingsFolder } from "../services/settings";

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
  const [autoDetecting, setAutoDetecting] = useState(false);
  const [autoDetectMessage, setAutoDetectMessage] = useState<string | null>(null);

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

  const handleAutodetect = async () => {
    setAutoDetecting(true);
    setAutoDetectMessage(null);
    try {
      const endpoint = await autodetectLocalEndpoint();
      if (endpoint) {
        setForm((prev) => ({ ...prev, sdEndpoint: endpoint }));
        await onUpdate({ sdEndpoint: endpoint });
        setAutoDetectMessage(`已检测到本地服务：${endpoint}`);
        setPingResult("idle");
      } else {
        setAutoDetectMessage("未找到可用的本地服务，请手动配置地址");
      }
    } catch (error) {
      console.warn("Autodetect failed", error);
      setAutoDetectMessage("自动探测失败，请检查本地服务是否已启动");
    } finally {
      setAutoDetecting(false);
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
          <button type="button" className="btn btn--ghost" onClick={openSettingsFolder}>
            打开数据目录
          </button>
          <button type="button" className="btn btn--ghost" onClick={handleAutodetect} disabled={autoDetecting}>
            {autoDetecting ? "探测中…" : "检测本地服务"}
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
        {autoDetectMessage && <div className="alert alert--info">{autoDetectMessage}</div>}
        {pingResult === "success" && <div className="alert alert--success">连接成功</div>}
        {pingResult === "error" && <div className="alert alert--error">无法连接到算力端</div>}
      </div>
    </section>
  );
};

export default SettingsPanel;
