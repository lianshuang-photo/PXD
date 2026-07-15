import {
  VFX_BLEND_LABELS,
  VFX_EFFECT_LABELS,
  vfxDegreeAdverb,
  type VfxBlendMode,
  type VfxConfig,
  type VfxEffectType
} from "../services/vfx";
import type { VfxPhase } from "../services/vfxWorkflow";

interface VfxEditorProps {
  config: VfxConfig;
  prompt: string;
  disabled: boolean;
  providerSupported: boolean;
  status: "idle" | VfxPhase | "success" | "error";
  onConfigChange: (patch: Partial<VfxConfig>) => void;
  onPromptChange: (value: string) => void;
  onRun: () => void;
}

const WeightControl = ({
  label,
  value,
  disabled,
  onChange
}: {
  label: string;
  value: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) => (
  <label className="vfx-editor__weight">
    <span>{label} · {vfxDegreeAdverb(value)} {Math.round(value * 100)}%</span>
    <input
      aria-label={`特效${label}`}
      type="range"
      min="0"
      max="1"
      step="0.01"
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(Number(event.target.value))}
    />
  </label>
);

const VfxEditor = ({
  config,
  prompt,
  disabled,
  providerSupported,
  status,
  onConfigChange,
  onPromptChange,
  onRun
}: VfxEditorProps) => (
  <section className="vfx-editor" aria-label="VFX 粒子特效">
    <div className="vfx-editor__header">
      <span>VFX 粒子特效</span>
      <span className="vfx-editor__swatch" style={{ backgroundColor: config.color }} aria-hidden="true" />
    </div>
    <div className="vfx-editor__selects">
      <label>
        <span>特效</span>
        <select
          className="input"
          aria-label="特效类型"
          value={config.effectType}
          disabled={disabled}
          onChange={(event) => onConfigChange({ effectType: event.target.value as VfxEffectType })}
        >
          {Object.entries(VFX_EFFECT_LABELS).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      </label>
      <label>
        <span>混合</span>
        <select
          className="input"
          aria-label="图层混合模式"
          value={config.blendMode}
          disabled={disabled}
          onChange={(event) => onConfigChange({ blendMode: event.target.value as VfxBlendMode })}
        >
          {Object.entries(VFX_BLEND_LABELS).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      </label>
    </div>
    <div className="vfx-editor__weights">
      <WeightControl label="强度" value={config.intensity} disabled={disabled} onChange={(intensity) => onConfigChange({ intensity })} />
      <WeightControl label="密度" value={config.density} disabled={disabled} onChange={(density) => onConfigChange({ density })} />
      <WeightControl label="范围" value={config.spread} disabled={disabled} onChange={(spread) => onConfigChange({ spread })} />
      <WeightControl label="发光" value={config.glow} disabled={disabled} onChange={(glow) => onConfigChange({ glow })} />
    </div>
    <label className="vfx-editor__direction">
      <span>方向 {Math.round(config.direction)}°</span>
      <input
        aria-label="特效方向"
        type="range"
        min="0"
        max="359"
        step="1"
        value={config.direction}
        disabled={disabled}
        onChange={(event) => onConfigChange({ direction: Number(event.target.value) })}
      />
    </label>
    <div className="vfx-editor__options">
      <label className="vfx-editor__color">
        <span>颜色</span>
        <input
          aria-label="特效颜色"
          type="color"
          value={config.color}
          disabled={disabled}
          onChange={(event) => onConfigChange({ color: event.target.value })}
        />
      </label>
      <label>
        <input
          aria-label="使用选区遮罩"
          type="checkbox"
          checked={config.useSelectionMask}
          disabled={disabled}
          onChange={(event) => onConfigChange({ useSelectionMask: event.target.checked })}
        />
        选区遮罩
      </label>
      <label>
        <input
          aria-label="透明背景"
          type="checkbox"
          checked={config.transparentBackground}
          disabled={disabled}
          onChange={(event) => onConfigChange({ transparentBackground: event.target.checked })}
        />
        透明背景
      </label>
    </div>
    <textarea
      className="input vfx-editor__prompt"
      aria-label="VFX 补充提示词"
      value={prompt}
      disabled={disabled}
      placeholder="补充特效要求"
      onChange={(event) => onPromptChange(event.target.value)}
    />
    <button
      type="button"
      className="btn btn--primary vfx-editor__run"
      disabled={disabled || !providerSupported}
      onClick={onRun}
    >
      {status === "preparing" || status === "generating" || status === "applying"
        ? "特效生成中"
        : "生成特效"}
    </button>
  </section>
);

export default VfxEditor;
