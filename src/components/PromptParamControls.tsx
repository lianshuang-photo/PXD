import { useEffect, useMemo, useRef } from "react";
import {
  PROMPT_PARAM_MAX,
  PROMPT_PARAM_MIN,
  PROMPT_PARAM_STEP,
  parsePromptParams,
  replacePromptParam
} from "../services/promptParams";

interface Props {
  prompt: string;
  label: string;
  onChange: (prompt: string) => void;
}

interface RangeProps {
  controlName: string;
  index: number;
  value: number;
  onUpdate: (index: number, nextValue: number) => void;
}

const PromptParamRange = ({ controlName, index, value, onUpdate }: RangeProps) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const updateRef = useRef(onUpdate);
  updateRef.current = onUpdate;

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.deltaY === 0) return;
      const direction = event.deltaY < 0 ? 1 : -1;
      updateRef.current(index, value + direction * PROMPT_PARAM_STEP);
    };
    input.addEventListener("wheel", handleWheel, { passive: false });
    return () => input.removeEventListener("wheel", handleWheel);
  }, [index, value]);

  return (
    <input
      ref={inputRef}
      className="prompt-param__range"
      type="range"
      min={PROMPT_PARAM_MIN}
      max={PROMPT_PARAM_MAX}
      step={PROMPT_PARAM_STEP}
      value={value}
      aria-label={`${controlName}滑块`}
      onChange={(event) => onUpdate(index, Number(event.target.value))}
    />
  );
};

const PromptParamControls = ({ prompt, label, onChange }: Props) => {
  const markers = useMemo(() => parsePromptParams(prompt), [prompt]);
  if (!markers.length) return null;

  const updateMarker = (index: number, nextValue: number) => {
    const marker = markers[index];
    if (!marker || !Number.isFinite(nextValue)) return;
    onChange(replacePromptParam(prompt, marker, nextValue));
  };

  return (
    <div className="prompt-params" aria-label={`${label}参数`}>
      {markers.map((marker, index) => {
        const controlName = `${label}-${marker.name}-${index + 1}`;
        return (
          <div className="prompt-param" key={marker.id}>
            <span className="prompt-param__name" title={marker.name}>{marker.name}</span>
            <PromptParamRange
              controlName={controlName}
              index={index}
              value={marker.value}
              onUpdate={updateMarker}
            />
            <input
              className="input prompt-param__value"
              type="number"
              min={PROMPT_PARAM_MIN}
              max={PROMPT_PARAM_MAX}
              step={PROMPT_PARAM_STEP}
              value={marker.value.toFixed(2)}
              aria-label={`${controlName}数值`}
              onChange={(event) => {
                if (!event.target.value.trim()) return;
                updateMarker(index, Number(event.target.value));
              }}
            />
          </div>
        );
      })}
    </div>
  );
};

export default PromptParamControls;
