import type { AppSettings } from "../context/types";
import type { GlobalPartitionOptions } from "../services/globalPartition";

interface GlobalPartitionControlsProps {
  provider: AppSettings["imageProvider"];
  options: GlobalPartitionOptions;
  running: boolean;
  disabled?: boolean;
  onChange: (next: Partial<GlobalPartitionOptions>) => void;
  onRun: () => void;
}

const clampInteger = (value: string, min: number, max: number) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.min(max, Math.max(min, Math.round(numeric)));
};

const GlobalPartitionControls = ({
  provider,
  options,
  running,
  disabled = false,
  onChange,
  onRun
}: GlobalPartitionControlsProps) => (
  <fieldset className="global-partition-controls" disabled={disabled || running}>
    <legend>大图全局分区</legend>
    <div className="global-partition-controls__sliders">
      <label>
        <span>重叠 <output>{options.overlap}px</output></span>
        <input
          type="range"
          min={0}
          max={512}
          step={8}
          value={options.overlap}
          onChange={(event) => onChange({ overlap: clampInteger(event.target.value, 0, 512) })}
        />
      </label>
      <label>
        <span>内收 <output>{options.maskContract}px</output></span>
        <input
          type="range"
          min={0}
          max={256}
          step={4}
          value={options.maskContract}
          onChange={(event) => onChange({ maskContract: clampInteger(event.target.value, 0, 256) })}
        />
      </label>
      <label>
        <span>模糊 <output>{options.maskFeather}px</output></span>
        <input
          type="range"
          min={0}
          max={512}
          step={4}
          value={options.maskFeather}
          onChange={(event) => onChange({ maskFeather: clampInteger(event.target.value, 0, 512) })}
        />
      </label>
    </div>
    <button
      type="button"
      className="btn btn--secondary global-partition-controls__run"
      onClick={onRun}
      disabled={disabled || running || provider !== "gemini"}
    >
      {running ? "分区处理中" : "运行分区"}
    </button>
    {provider !== "gemini" && <span className="global-partition-controls__provider">需要 Gemini</span>}
  </fieldset>
);

export default GlobalPartitionControls;
