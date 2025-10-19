import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import type { AppSettings } from "../context/types";
import { useGenerationController } from "../hooks/useGenerationController";
import OverlayPortal from "../components/OverlayPortal";

interface Props {
  settings: AppSettings;
  onOpenSettings: () => void;
}

const statusLabelMap: Record<string, string> = {
  idle: "待命",
  running: "生成中…",
  success: "生成成功",
  error: "生成失败"
};

const languageOptions = [
  { value: "zh", label: "中文" },
  { value: "en", label: "English" },
  { value: "ja", label: "日本語" },
  { value: "ko", label: "한국어" }
];

const resolutionPresets = [768, 1024, 1536, 2048];

const formatDateTime = (value: string) => {
  try {
    const date = new Date(value);
    return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
  } catch {
    return value;
  }
};

const MainPanel = ({ settings, onOpenSettings }: Props) => {
  const controller = useGenerationController(settings);
  const {
    form,
    setFormValue,
    resetForm,
    setResolution,
    setPresetShortcut,
    status,
    progress,
    error,
    lastImages,
    options,
    optionsLoading,
    optionsError,
    refreshOptions,
    runGeneration,
    batchItems,
    addToBatch,
    removeFromBatch,
    clearBatch,
    runBatch,
    toast,
    dismissToast,
    presets,
    selectedPreset,
    loadPresets,
    applyPreset,
    savePreset,
    deletePreset,
    setSelectedPreset,
    pushToast,
    translationInput,
    setTranslationInput,
    translationResult,
    translationError,
    translationLoading,
    sourceLanguage,
    targetLanguage,
    setSourceLanguage,
    setTargetLanguage,
    runTranslation,
    clearTranslation,
    appendTranslationToPositive,
    appendTranslationToNegative,
    appendExtraPromptToPositive,
    appendExtraPromptToNegative
  } = controller;

  const [presetFile, setPresetFile] = useState<string>("");
  const [presetName, setPresetName] = useState<string>("");
  const [customResolution, setCustomResolution] = useState(false);
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const confirmResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!presets.length) {
      setPresetFile("");
      setPresetName("");
      setSelectedPreset(null);
      return;
    }
    const matched = selectedPreset ? presets.find((preset) => preset.name === selectedPreset) : null;
    if (matched) {
      setPresetFile(matched.fileName);
    } else if (!presetFile || !presets.some((preset) => preset.fileName === presetFile)) {
      const first = presets[0];
      setPresetFile(first.fileName);
      setSelectedPreset(first.name);
    }
  }, [presetFile, presets, selectedPreset, setSelectedPreset]);

  useEffect(() => {
    setPresetName("");
  }, [selectedPreset]);

  const selectedPresetMeta = useMemo(
    () => presets.find((item) => item.fileName === presetFile) ?? null,
    [presetFile, presets]
  );
  const clearConfirmTimer = () => {
    if (confirmResetTimer.current) {
      clearTimeout(confirmResetTimer.current);
      confirmResetTimer.current = null;
    }
  };
  const scheduleConfirmReset = () => {
    clearConfirmTimer();
    confirmResetTimer.current = setTimeout(() => {
      setConfirmOverwrite(false);
      confirmResetTimer.current = null;
    }, 5000);
  };
  useEffect(() => {
    clearConfirmTimer();
    setConfirmOverwrite(false);
  }, [presetName, selectedPresetMeta]);
  useEffect(
    () => () => {
      clearConfirmTimer();
    },
    []
  );

  const trimmedPresetName = presetName.trim();
  const isSaveMode = trimmedPresetName.length > 0;
  const saveButtonLabel = isSaveMode ? "保存" : "覆盖";
  const isSaveDisabled = isSaveMode ? false : !selectedPresetMeta;

  const handleSavePreset = async () => {
    const name = presetName.trim();
    const targetPreset = selectedPresetMeta;
    if (name) {
      try {
        await savePreset(name);
        await loadPresets();
        setConfirmOverwrite(false);
        clearConfirmTimer();
      } catch (err) {
        const message = err instanceof Error ? err.message : "保存预设失败";
        pushToast("error", message);
      }
      return;
    }

    if (!targetPreset) {
      pushToast("warning", "请选择要覆盖的预设");
      return;
    }

    if (!confirmOverwrite) {
      setConfirmOverwrite(true);
      pushToast("warning", "再次点击覆盖将替换当前预设");
      scheduleConfirmReset();
      return;
    }

    try {
      await savePreset(targetPreset.name);
      await loadPresets();
      setConfirmOverwrite(false);
      clearConfirmTimer();
    } catch (err) {
      const message = err instanceof Error ? err.message : "保存预设失败";
      pushToast("error", message);
      setConfirmOverwrite(false);
      clearConfirmTimer();
    }
  };

  const handleApplyPreset = async () => {
    if (!presetFile) return;
    try {
      await applyPreset(presetFile);
    } catch (err) {
      const message = err instanceof Error ? err.message : "应用预设失败";
      pushToast("error", message);
    }
  };

  const handleDeletePreset = async () => {
    if (!presetFile) return;
    try {
      await deletePreset(presetFile);
      await loadPresets();
    } catch (err) {
      const message = err instanceof Error ? err.message : "删除预设失败";
      pushToast("error", message);
    }
  };

  const samplerOptions = useMemo(
    () =>
      options.samplers.map((item) => (
        <option key={item.value} value={item.value}>
          {item.label}
        </option>
      )),
    [options.samplers]
  );

  const modelOptions = useMemo(
    () =>
      options.models.map((item) => (
        <option key={item.value} value={item.value}>
          {item.label}
        </option>
      )),
    [options.models]
  );

  const vaeOptions = useMemo(
    () =>
      options.vaes.map((item) => (
        <option key={item.value} value={item.value}>
          {item.label}
        </option>
      )),
    [options.vaes]
  );

  const loraOptions = useMemo(
    () =>
      [
        <option key="none" value="">
          不使用
        </option>
      ].concat(
        options.loras.map((item) => (
          <option key={item.value} value={item.value}>
            {item.label}
          </option>
        ))
      ),
    [options.loras]
  );

  const schedulerOptions = useMemo(
    () =>
      options.schedulers.map((item) => (
        <option key={item.value} value={item.value}>
          {item.label}
        </option>
      )),
    [options.schedulers]
  );

  const controlNetModelOptions = useMemo(
    () =>
      [
        <option key="none" value="">
          不使用
        </option>
      ].concat(
        options.controlNetModels.map((item) => (
          <option key={item.value} value={item.value}>
            {item.label}
          </option>
        ))
      ),
    [options.controlNetModels]
  );

  const controlNetModuleOptions = useMemo(
    () =>
      [
        <option key="none" value="">
          默认
        </option>
      ].concat(
        options.controlNetModules.map((item) => (
          <option key={item.value} value={item.value}>
            {item.label}
          </option>
        ))
      ),
    [options.controlNetModules]
  );

  const progressPercent = Math.max(0, Math.min(100, Math.round(progress * 100)));
  const presetActionButtonStyle: CSSProperties = {
    flex: "1 1 auto",
    fontSize: "0.55rem",
    padding: "0 0.15rem",
    lineHeight: 1,
    minWidth: "fit-content"
  };
  const compactTopActionButtonStyle: CSSProperties = {
    flex: "1 1 auto",
    fontSize: "0.55rem",
    padding: "0.15rem 0.25rem",
    lineHeight: 1,
    minWidth: "fit-content"
  };
  const compactLabelStyle: CSSProperties = {
    fontSize: "0.85rem",
    lineHeight: 1.3,
    color: "var(--text-secondary)",
    flexShrink: 0
  };

  const handleSwapLanguages = () => {
    setSourceLanguage(targetLanguage);
    setTargetLanguage(sourceLanguage);
  };

  return (
    <>
      <section
        className="app-panel"
        style={{
          padding: "0",
          gap: "0",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          overflow: "visible",
          position: "relative"
        }}
      >
      {/* 简化的操作栏 */}
      <div style={{ 
        display: "flex", 
        gap: "0.12rem", 
        padding: "0.12rem 0.18rem", 
        flexWrap: "wrap",
        borderBottom: "1px solid var(--border-color)",
        flexShrink: 0
      }}>
        <button
          type="button"
          className="btn btn--primary"
          onClick={runGeneration}
          disabled={status === "running" || optionsLoading}
          style={compactTopActionButtonStyle}
        >
          {status === "running" ? "生成中" : "开始生成"}
        </button>
        <button 
          type="button" 
          className="btn btn--secondary" 
          onClick={addToBatch}
          style={compactTopActionButtonStyle}
        >
          加入批次
        </button>
        <button
          type="button"
          className="btn btn--secondary"
          onClick={runBatch}
          disabled={!batchItems.length || status === "running"}
          style={compactTopActionButtonStyle}
        >
          执行批次
        </button>
        <button 
          type="button" 
          className="btn btn--ghost" 
          onClick={refreshOptions} 
          disabled={optionsLoading}
          style={compactTopActionButtonStyle}
        >
          {optionsLoading ? "同步中" : "刷新"}
        </button>
      </div>
      
      {/* 进度条和错误提示 */}
      {status === "running" && (
        <div style={{ padding: "0.5rem", background: "rgba(60, 131, 246, 0.1)", borderBottom: "1px solid var(--border-color)", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.75rem" }}>
            <div style={{ flex: 1, height: "4px", background: "rgba(255,255,255,0.1)", borderRadius: "2px", overflow: "hidden" }}>
              <div style={{ height: "100%", background: "var(--brand-color)", width: `${progressPercent}%`, transition: "width 0.3s" }} />
            </div>
            <span>{progressPercent}%</span>
          </div>
        </div>
      )}
      {error && status === "error" && (
        <div style={{ padding: "0.5rem", background: "rgba(239, 68, 68, 0.1)", color: "#f87171", fontSize: "0.75rem", borderBottom: "1px solid var(--border-color)", flexShrink: 0 }}>
          {error}
        </div>
      )}
      {optionsError && (
        <div style={{ padding: "0.5rem", background: "rgba(245, 158, 11, 0.1)", color: "#fbbf24", fontSize: "0.75rem", borderBottom: "1px solid var(--border-color)", flexShrink: 0 }}>
          {optionsError}
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "0.2rem", boxSizing: "border-box" }}>
        <div style={{ maxWidth: "100%", width: "100%", boxSizing: "border-box" }}>
          <article style={{ width: "100%", padding: "0.25rem", background: "var(--bg-panel)", borderRadius: "4px", boxSizing: "border-box" }}>
            <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: "0.2rem", boxSizing: "border-box" }}>
              {/* 预设 */}
              <div>
                <div style={{ display: "flex", gap: "0.12rem", marginBottom: "0.12rem" }}>
                  <select
                    className="input"
                    value={presetFile}
                    onChange={(event) => {
                      const value = event.target.value;
                      setPresetFile(value);
                      const meta = presets.find((item) => item.fileName === value);
                      setSelectedPreset(meta ? meta.name : null);
                      setPresetName("");
                    }}
                    style={{ flex: 1 }}
                  >
                    {presets.length === 0 && <option value="">选择预设</option>}
                    {presets.map((item) => (
                      <option key={item.fileName} value={item.fileName}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                  <input
                    className="input"
                    type="text"
                    value={presetName}
                    onChange={(event) => setPresetName(event.target.value)}
                    placeholder="预设名称"
                    style={{ flex: 1 }}
                  />
                </div>
                <div style={{ display: "flex", gap: "0.08rem", flexWrap: "wrap" }}>
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={handleSavePreset}
                    disabled={isSaveDisabled}
                    style={{
                      ...presetActionButtonStyle,
                      ...(!isSaveMode && confirmOverwrite
                        ? {
                            borderColor: "rgba(239, 68, 68, 0.6)",
                            background: "rgba(239, 68, 68, 0.12)"
                          }
                        : {})
                    }}
                  >
                    {saveButtonLabel}
                  </button>
                  <button type="button" className="btn btn--ghost" onClick={handleApplyPreset} disabled={!presetFile} style={presetActionButtonStyle}>
                    应用
                  </button>
                  <button type="button" className="btn btn--ghost" onClick={handleDeletePreset} disabled={!presetFile} style={presetActionButtonStyle}>
                    删除
                  </button>
                  <button type="button" className="btn btn--ghost" onClick={resetForm} style={presetActionButtonStyle}>
                    清空
                  </button>
                </div>
              </div>
              
              {/* 模型与采样 */}
              <hr style={{ margin: "0.2rem 0", border: "none", borderTop: "1px solid rgba(128, 128, 128, 0.25)" }} />
              <div style={{ display: "flex", alignItems: "center", gap: "0.12rem", marginBottom: "0.12rem" }}>
                <span style={{ ...compactLabelStyle, minWidth: "1.5rem" }}>模型</span>
                <select className="input" value={form.model} onChange={(event) => setFormValue("model", event.target.value)} style={{ flex: 1, minWidth: 0 }}>
                  {modelOptions}
                </select>
              </div>
              <div style={{ display: "flex", gap: "0.12rem", marginBottom: "0.12rem" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.12rem", flex: 1, minWidth: 0 }}>
                  <span style={{ ...compactLabelStyle, minWidth: "1.5rem" }}>VAE</span>
                  <select className="input" value={form.vae} onChange={(event) => setFormValue("vae", event.target.value)} style={{ flex: 1, minWidth: 0 }}>
                    {vaeOptions}
                  </select>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "0.12rem", flex: 1, minWidth: 0 }}>
                  <span style={{ ...compactLabelStyle, minWidth: "1.5rem" }}>采样器</span>
                  <select className="input" value={form.sampler} onChange={(event) => setFormValue("sampler", event.target.value)} style={{ flex: 1, minWidth: 0 }}>
                    {samplerOptions}
                  </select>
                </div>
              </div>
              <div style={{ display: "flex", gap: "0.12rem", marginBottom: "0.12rem" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.12rem", flex: 1, minWidth: 0 }}>
                  <span style={{ ...compactLabelStyle, minWidth: "1.5rem" }}>调度</span>
                  <select className="input" value={form.scheduler} onChange={(event) => setFormValue("scheduler", event.target.value)} style={{ flex: 1, minWidth: 0 }}>
                    {schedulerOptions}
                  </select>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "0.12rem", flex: 1, minWidth: 0 }}>
                  <span style={{ ...compactLabelStyle, minWidth: "1.5rem" }}>LoRA</span>
                  <select className="input" value={form.lora} onChange={(event) => setFormValue("lora", event.target.value)} style={{ flex: 1, minWidth: 0 }}>
                    {loraOptions}
                  </select>
                  <input
                    className="input"
                    type="number"
                    step={0.1}
                    value={form.loraWeight}
                    onChange={(event) => setFormValue("loraWeight", Number(event.target.value))}
                    disabled={!form.lora}
                    placeholder="权重"
                    style={{ width: "40px", minWidth: 0 }}
                  />
                </div>
              </div>
              
              {/* 生成参数 */}
              <hr style={{ margin: "0.2rem 0", border: "none", borderTop: "1px solid rgba(128, 128, 128, 0.25)" }} />
              <div style={{ display: "flex", gap: "0.12rem", marginBottom: "0.12rem" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.12rem", flex: 1, minWidth: 0 }}>
                  <span style={{ ...compactLabelStyle, minWidth: "1.2rem" }}>步数</span>
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={150}
                    value={form.steps}
                    onChange={(event) => setFormValue("steps", Number(event.target.value))}
                    style={{ flex: 1, minWidth: 0 }}
                  />
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "0.12rem", flex: 1, minWidth: 0 }}>
                  <span style={{ ...compactLabelStyle, minWidth: "1.2rem" }}>CFG</span>
                  <input
                    className="input"
                    type="number"
                    step={0.5}
                    min={1}
                    max={30}
                    value={form.cfgScale}
                    onChange={(event) => setFormValue("cfgScale", Number(event.target.value))}
                    style={{ flex: 1, minWidth: 0 }}
                  />
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "0.12rem", flex: 1, minWidth: 0 }}>
                  <span style={{ ...compactLabelStyle, minWidth: "1.2rem" }}>重绘</span>
                  <input
                    className="input"
                    type="number"
                    step={0.05}
                    min={0}
                    max={0.99}
                    value={form.denoisingStrength}
                    onChange={(event) => setFormValue("denoisingStrength", Number(event.target.value))}
                    style={{ flex: 1, minWidth: 0 }}
                  />
                </div>
              </div>
              <div style={{ display: "flex", gap: "0.12rem", marginBottom: "0.12rem" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.12rem", flex: 1, minWidth: 0 }}>
                  <span style={{ ...compactLabelStyle, minWidth: "1.2rem" }}>种子</span>
                  <input
                    className="input"
                    type="number"
                    value={form.seed}
                    onChange={(event) => setFormValue("seed", Number(event.target.value))}
                    placeholder="-1随机"
                    style={{ flex: 1, minWidth: 0 }}
                  />
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "0.12rem", flex: 1, minWidth: 0 }}>
                  <span style={{ ...compactLabelStyle, minWidth: "1.2rem" }}>CLIP</span>
                  <input
                    className="input"
                    type="number"
                    min={0}
                    max={12}
                    value={form.clipSkip}
                    onChange={(event) => setFormValue("clipSkip", Number(event.target.value))}
                    style={{ flex: 1, minWidth: 0 }}
                  />
                </div>
              </div>
              <div style={{ display: "flex", gap: "0.12rem" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.12rem", flex: 1, minWidth: 0 }}>
                  <span style={{ ...compactLabelStyle, minWidth: "1.5rem" }}>分辨率</span>
                  <select 
                    className="input" 
                    value={customResolution ? 'custom' : (resolutionPresets.includes(form.resolution) ? form.resolution : resolutionPresets[0])}
                    onChange={(event) => {
                      const val = event.target.value;
                      if (val === 'custom') {
                        setCustomResolution(true);
                      } else {
                        setCustomResolution(false);
                        setFormValue("resolution", Number(val));
                      }
                    }}
                    style={{ width: customResolution ? '100px' : 'auto', flex: customResolution ? '0 0 auto' : 1, minWidth: 0 }}
                  >
                    {resolutionPresets.map((value) => (
                      <option key={value} value={value}>{value}</option>
                    ))}
                    <option value="custom">自定义</option>
                  </select>
                  {customResolution && (
                    <input
                      className="input"
                      type="number"
                      min={128}
                      max={2048}
                      value={form.resolution}
                      onChange={(event) => setFormValue("resolution", Number(event.target.value))}
                      style={{ flex: 2, minWidth: 0 }}
                      placeholder="输入分辨率"
                    />
                  )}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "0.12rem", width: "120px", flexShrink: 0 }}>
                  <span style={{ ...compactLabelStyle, minWidth: "1.2rem" }}>羽化</span>
                  <input
                    className="input"
                    type="number"
                    min={0}
                    max={1200}
                    step={1}
                    value={form.maskFeather}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      const safeValue = Number.isFinite(value) ? Math.min(Math.max(value, 0), 1200) : 0;
                      setFormValue("maskFeather", safeValue);
                    }}
                    style={{ flex: 1, minWidth: 0 }}
                  />
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "0.12rem", flex: 1, minWidth: 0 }}>
                  <span style={{ ...compactLabelStyle, minWidth: "1.5rem" }}>数量</span>
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={8}
                    value={form.imageCount}
                    onChange={(event) => setFormValue("imageCount", Number(event.target.value))}
                    style={{ flex: 1, minWidth: 0 }}
                  />
                </div>
              </div>
              
              {/* ControlNet */}
              <hr style={{ margin: "0.2rem 0", border: "none", borderTop: "1px solid rgba(128, 128, 128, 0.25)" }} />
              <div style={{ display: "flex", alignItems: "center", gap: "0.12rem", marginBottom: "0.12rem" }}>
                <span style={{ ...compactLabelStyle, minWidth: "1.5rem" }}>模型</span>
                <select
                  className="input"
                  value={form.controlNetModel}
                  onChange={(event) => setFormValue("controlNetModel", event.target.value)}
                  style={{ flex: 1, minWidth: 0 }}
                >
                  {controlNetModelOptions}
                </select>
              </div>
              <div style={{ display: "flex", gap: "0.12rem" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.12rem", flex: 1, minWidth: 0 }}>
                  <span style={{ ...compactLabelStyle, minWidth: "1.5rem" }}>预处理</span>
                  <select
                    className="input"
                    value={form.controlNetModule}
                    onChange={(event) => setFormValue("controlNetModule", event.target.value)}
                    style={{ flex: 1, minWidth: 0 }}
                  >
                    {controlNetModuleOptions}
                  </select>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "0.12rem", flexShrink: 0 }}>
                  <span style={compactLabelStyle}>强度</span>
                  <input
                    className="input"
                    type="number"
                    min={0}
                    max={2}
                    step={0.1}
                    value={form.controlNetWeight}
                    onChange={(event) => setFormValue("controlNetWeight", Number(event.target.value))}
                    disabled={!form.controlNetModel}
                    style={{ width: "70px" }}
                  />
                </div>
              </div>
              
              {/* 提示词 */}
              <hr style={{ margin: "0.5rem 0", border: "none", borderTop: "1px solid rgba(128, 128, 128, 0.25)" }} />
              <textarea
                className="input input--multiline"
                value={form.positivePrompt}
                onChange={(event) => setFormValue("positivePrompt", event.target.value)}
                onPaste={(event) => {
                  event.preventDefault();
                  const text = event.clipboardData?.getData("text/plain") || "";
                  const target = event.target as HTMLTextAreaElement;
                  const start = target.selectionStart || 0;
                  const end = target.selectionEnd || 0;
                  const current = form.positivePrompt;
                  const newValue = current.slice(0, start) + text + current.slice(end);
                  setFormValue("positivePrompt", newValue);
                  // 设置光标位置
                  setTimeout(() => {
                    target.selectionStart = target.selectionEnd = start + text.length;
                  }, 0);
                }}
                rows={2}
                placeholder="正向提示词"
                style={{ marginBottom: "0.35rem" }}
              />
              <textarea
                className="input input--multiline"
                value={form.negativePrompt}
                onChange={(event) => setFormValue("negativePrompt", event.target.value)}
                onPaste={(event) => {
                  event.preventDefault();
                  const text = event.clipboardData?.getData("text/plain") || "";
                  const target = event.target as HTMLTextAreaElement;
                  const start = target.selectionStart || 0;
                  const end = target.selectionEnd || 0;
                  const current = form.negativePrompt;
                  const newValue = current.slice(0, start) + text + current.slice(end);
                  setFormValue("negativePrompt", newValue);
                  setTimeout(() => {
                    target.selectionStart = target.selectionEnd = start + text.length;
                  }, 0);
                }}
                rows={2}
                placeholder="反向提示词"
                style={{ marginBottom: "0.35rem" }}
              />
              <div style={{ display: "flex", gap: "0.35rem", marginBottom: "0.35rem" }}>
                <textarea
                  className="input input--multiline"
                  value={form.extraPrompt}
                  onChange={(event) => setFormValue("extraPrompt", event.target.value)}
                  onPaste={(event) => {
                    event.preventDefault();
                    const text = event.clipboardData?.getData("text/plain") || "";
                    const target = event.target as HTMLTextAreaElement;
                    const start = target.selectionStart || 0;
                    const end = target.selectionEnd || 0;
                    const current = form.extraPrompt;
                    const newValue = current.slice(0, start) + text + current.slice(end);
                    setFormValue("extraPrompt", newValue);
                    setTimeout(() => {
                      target.selectionStart = target.selectionEnd = start + text.length;
                    }, 0);
                  }}
                  rows={2}
                  placeholder="追加提示词"
                  style={{ flex: 1 }}
                />
                <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
                  <button type="button" className="btn btn--secondary" onClick={appendExtraPromptToPositive} style={{ whiteSpace: "nowrap" }}>
                    +正向
                  </button>
                  <button type="button" className="btn btn--ghost" onClick={appendExtraPromptToNegative} style={{ whiteSpace: "nowrap" }}>
                    +反向
                  </button>
                </div>
              </div>
              
              {/* 翻译 */}
              <hr style={{ margin: "0.5rem 0", border: "none", borderTop: "1px solid rgba(128, 128, 128, 0.25)" }} />
              <div style={{ fontSize: "0.7rem", fontWeight: 500, marginBottom: "0.25rem", color: "var(--color-text-secondary)" }}>翻译助手（这个懒得找api也没啥用，如果你向下滑看到了就当没看见吧～）</div>
              <div style={{ display: "flex", gap: "0.35rem", marginBottom: "0.35rem" }}>
                <select
                  className="input"
                  value={sourceLanguage}
                  onChange={(event) => setSourceLanguage(event.target.value)}
                  style={{ flex: 1 }}
                >
                  {languageOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <button type="button" className="btn btn--ghost" onClick={handleSwapLanguages} style={{ padding: "0 0.5rem" }}>
                  ⇅
                </button>
                <select
                  className="input"
                  value={targetLanguage}
                  onChange={(event) => setTargetLanguage(event.target.value)}
                  style={{ flex: 1 }}
                >
                  {languageOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              <textarea
                className="input input--multiline"
                value={translationInput}
                onChange={(event) => setTranslationInput(event.target.value)}
                onPaste={(event) => {
                  event.preventDefault();
                  const text = event.clipboardData?.getData("text/plain") || "";
                  const target = event.target as HTMLTextAreaElement;
                  const start = target.selectionStart || 0;
                  const end = target.selectionEnd || 0;
                  const current = translationInput;
                  const newValue = current.slice(0, start) + text + current.slice(end);
                  setTranslationInput(newValue);
                  setTimeout(() => {
                    target.selectionStart = target.selectionEnd = start + text.length;
                  }, 0);
                }}
                rows={2}
                placeholder="待翻译内容"
                style={{ marginBottom: "0.35rem" }}
              />
              <div style={{ display: "flex", gap: "0.35rem", marginBottom: "0.35rem", flexWrap: "wrap" }}>
                <button type="button" className="btn btn--primary" onClick={runTranslation} disabled={translationLoading} style={{ flex: "1 1 auto" }}>
                  {translationLoading ? "翻译中" : "翻译"}
                </button>
                <button type="button" className="btn btn--ghost" onClick={appendTranslationToPositive} style={{ flex: "1 1 auto" }}>
                  +正向
                </button>
                <button type="button" className="btn btn--ghost" onClick={appendTranslationToNegative} style={{ flex: "1 1 auto" }}>
                  +反向
                </button>
                <button type="button" className="btn btn--ghost" onClick={clearTranslation} style={{ flex: "1 1 auto" }}>
                  清空
                </button>
              </div>
              <textarea
                className="input input--multiline"
                value={translationResult}
                readOnly
                rows={2}
                placeholder="翻译结果"
                style={{ marginBottom: "0.5rem" }}
              />
              {translationError && <div style={{ color: "var(--color-error)", fontSize: "0.875rem", marginTop: "-0.35rem", marginBottom: "0.5rem" }}>{translationError}</div>}
              
              {/* 批次队列 */}
              {batchItems.length > 0 && (
                <>
                  <hr style={{ margin: "1rem 0", border: "none", borderTop: "1px solid var(--color-border, #e0e0e0)" }} />
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
                    <span style={{ fontSize: "0.875rem", fontWeight: 500 }}>批次队列 ({batchItems.length})</span>
                    <button type="button" className="btn btn--ghost" onClick={clearBatch} style={{ padding: "0.25rem 0.5rem", fontSize: "0.75rem" }}>
                      清空
                    </button>
                  </div>
                  <ul style={{ listStyle: "none", padding: 0, margin: "0 0 1rem 0" }}>
                    {batchItems.map((item) => (
                      <li key={item.id} style={{ padding: "0.5rem", border: "1px solid var(--color-border, #e0e0e0)", borderRadius: "4px", marginBottom: "0.5rem", fontSize: "0.75rem" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.25rem" }}>
                          <span style={{ fontWeight: 500 }}>{item.name}</span>
                          <button type="button" className="btn btn--ghost" onClick={() => removeFromBatch(item.id)} style={{ padding: "0.125rem 0.5rem", fontSize: "0.75rem" }}>
                            移除
                          </button>
                        </div>
                        <div style={{ color: "var(--color-text-secondary)", fontSize: "0.7rem" }}>
                          {item.overrideWidth}×{item.overrideHeight} · {item.form.steps}步 · CFG{item.form.cfgScale}
                        </div>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              
              {/* 最近输出 */}
              {lastImages.length > 0 && (
                <>
                  <hr style={{ margin: "1rem 0", border: "none", borderTop: "1px solid var(--color-border, #e0e0e0)" }} />
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(100px, 1fr))", gap: "0.5rem" }}>
                    {lastImages.map((src, index) => (
                      <img key={`${src}-${index}`} src={src} alt={`result-${index}`} style={{ width: "100%", borderRadius: "4px" }} />
                    ))}
                  </div>
                </>
              )}
            </div>
          </article>
        </div>
      </div>

      </section>
      {toast && (
        <OverlayPortal>
          <div className={`toast toast--${toast.type}`}>
            <span>{toast.message}</span>
            <button type="button" className="btn btn--ghost" onClick={dismissToast}>
              关闭
            </button>
          </div>
        </OverlayPortal>
      )}
    </>
  );
};

export default MainPanel;
