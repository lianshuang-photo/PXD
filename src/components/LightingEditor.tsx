import { useMemo, useState, type PointerEvent } from "react";
import {
  pointFromStageCoordinates,
  RELIGHT_LIGHT_TYPE_LABELS,
  RELIGHT_ROLE_LABELS,
  temperatureToCssColor,
  type RelightLight,
  type RelightLightType,
  type RelightRole
} from "../services/relight";
import type { RelightPhase } from "../services/relightWorkflow";

interface LightingEditorProps {
  lights: RelightLight[];
  opacity: number;
  selectedId: string | null;
  prompt: string;
  disabled: boolean;
  providerSupported: boolean;
  status: "idle" | RelightPhase | "success" | "error";
  onSelect: (id: string) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  onChange: (id: string, patch: Partial<RelightLight>) => void;
  onOpacityChange: (value: number) => void;
  onPromptChange: (value: string) => void;
  onRun: () => void;
}

const LightingEditor = ({
  lights,
  opacity,
  selectedId,
  prompt,
  disabled,
  providerSupported,
  status,
  onSelect,
  onAdd,
  onRemove,
  onChange,
  onOpacityChange,
  onPromptChange,
  onRun
}: LightingEditorProps) => {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const selected = useMemo(
    () => lights.find((light) => light.id === selectedId) ?? lights[0] ?? null,
    [lights, selectedId]
  );

  const updatePosition = (event: PointerEvent<HTMLElement>, id: string) => {
    const stage = event.currentTarget.closest(".lighting-editor__stage") as HTMLElement | null;
    if (!stage) return;
    const point = pointFromStageCoordinates(
      event.clientX,
      event.clientY,
      stage.getBoundingClientRect()
    );
    onChange(id, point);
  };

  return (
    <section className="lighting-editor" aria-label="可视化打光">
      <div className="lighting-editor__header">
        <span className="lighting-editor__title">可视化打光</span>
        <div className="lighting-editor__actions">
          <button
            type="button"
            className="lighting-editor__icon-button"
            aria-label="添加灯光"
            title="添加灯光"
            onClick={onAdd}
            disabled={disabled || lights.length >= 8}
          >
            +
          </button>
          <button
            type="button"
            className="lighting-editor__icon-button"
            aria-label="删除选中灯光"
            title="删除选中灯光"
            onClick={() => selected && onRemove(selected.id)}
            disabled={disabled || !selected}
          >
            −
          </button>
        </div>
      </div>

      <div
        className="lighting-editor__stage"
        data-testid="lighting-stage"
        onPointerMove={(event) => {
          if (draggingId) updatePosition(event, draggingId);
        }}
        onPointerUp={(event) => {
          if (draggingId) updatePosition(event, draggingId);
          setDraggingId(null);
          event.currentTarget.releasePointerCapture?.(event.pointerId);
        }}
        onPointerCancel={() => setDraggingId(null)}
      >
        <div className="lighting-editor__subject" aria-hidden="true" />
        {lights.map((light, index) => (
          <button
            type="button"
            key={light.id}
            className={light.id === selected?.id
              ? "lighting-editor__light lighting-editor__light--selected"
              : "lighting-editor__light"}
            style={{
              left: `${light.x * 100}%`,
              top: `${light.y * 100}%`,
              backgroundColor: temperatureToCssColor(light.temperature)
            }}
            aria-label={`${RELIGHT_ROLE_LABELS[light.role]} ${index + 1}`}
            onPointerDown={(event) => {
              event.preventDefault();
              onSelect(light.id);
              setDraggingId(light.id);
              event.currentTarget.parentElement?.setPointerCapture?.(event.pointerId);
              updatePosition(event, light.id);
            }}
            onClick={() => onSelect(light.id)}
          >
            <span
              className="lighting-editor__direction"
              style={{ transform: `rotate(${light.direction}deg)` }}
              aria-hidden="true"
            >
              →
            </span>
          </button>
        ))}
      </div>

      {selected && (
        <div className="lighting-editor__controls">
          <label>
            <span>角色</span>
            <select
              className="input"
              aria-label="灯光角色"
              value={selected.role}
              disabled={disabled}
              onChange={(event) => onChange(selected.id, { role: event.target.value as RelightRole })}
            >
              {Object.entries(RELIGHT_ROLE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <label>
            <span>类型</span>
            <select
              className="input"
              aria-label="灯光类型"
              value={selected.type}
              disabled={disabled}
              onChange={(event) => onChange(selected.id, { type: event.target.value as RelightLightType })}
            >
              {Object.entries(RELIGHT_LIGHT_TYPE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <label>
            <span>强度 {Math.round(selected.intensity * 100)}%</span>
            <input
              aria-label="灯光强度"
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={selected.intensity}
              disabled={disabled}
              onChange={(event) => onChange(selected.id, { intensity: Number(event.target.value) })}
            />
          </label>
          <label>
            <span>色温 {selected.temperature}K</span>
            <input
              aria-label="灯光色温"
              type="range"
              min="2000"
              max="10000"
              step="100"
              value={selected.temperature}
              disabled={disabled}
              onChange={(event) => onChange(selected.id, { temperature: Number(event.target.value) })}
            />
          </label>
          <label className="lighting-editor__control--wide">
            <span>方向 {Math.round(selected.direction)}°</span>
            <input
              aria-label="灯光方向"
              type="range"
              min="0"
              max="359"
              step="1"
              value={selected.direction}
              disabled={disabled}
              onChange={(event) => onChange(selected.id, { direction: Number(event.target.value) })}
            />
          </label>
        </div>
      )}

      <label className="lighting-editor__opacity">
        <span>能量层不透明度 {Math.round(opacity)}%</span>
        <input
          aria-label="能量层不透明度"
          type="range"
          min="0"
          max="100"
          step="1"
          value={opacity}
          disabled={disabled}
          onChange={(event) => onOpacityChange(Number(event.target.value))}
        />
      </label>

      <textarea
        className="input lighting-editor__prompt"
        aria-label="重新打光补充提示词"
        value={prompt}
        disabled={disabled}
        onChange={(event) => onPromptChange(event.target.value)}
        placeholder="补充打光要求"
      />
      <button
        type="button"
        className="btn btn--primary lighting-editor__run"
        onClick={onRun}
        disabled={disabled || !providerSupported || lights.length === 0}
      >
        {status === "preparing" || status === "generating" || status === "applying"
          ? "重新打光中"
          : "重新打光"}
      </button>
    </section>
  );
};

export default LightingEditor;
