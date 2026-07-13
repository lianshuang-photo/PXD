import { useMemo } from "react";
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
            <input
              className="prompt-param__range"
              type="range"
              min={PROMPT_PARAM_MIN}
              max={PROMPT_PARAM_MAX}
              step={PROMPT_PARAM_STEP}
              value={marker.value}
              aria-label={`${controlName}滑块`}
              onChange={(event) => updateMarker(index, Number(event.target.value))}
              onWheel={(event) => {
                event.preventDefault();
                if (event.deltaY === 0) return;
                const direction = event.deltaY < 0 ? 1 : -1;
                updateMarker(index, marker.value + direction * PROMPT_PARAM_STEP);
              }}
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
