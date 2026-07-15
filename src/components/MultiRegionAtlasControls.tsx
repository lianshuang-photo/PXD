import type { AppSettings } from "../context/types";
import { MAX_ATLAS_REGIONS, type AtlasRegionCapture } from "../services/multiRegionAtlas";

interface Props {
  provider: AppSettings["imageProvider"];
  regions: AtlasRegionCapture[];
  disabled: boolean;
  running: boolean;
  stopping: boolean;
  onAdd: () => void | Promise<void>;
  onRemove: (id: string) => void;
  onClear: () => void;
  onRun: () => void | Promise<void>;
}

const MultiRegionAtlasControls = ({
  provider,
  regions,
  disabled,
  running,
  stopping,
  onAdd,
  onRemove,
  onClear,
  onRun
}: Props) => {
  const locked = disabled || running || stopping;
  return (
    <fieldset className="atlas-controls" disabled={locked}>
      <legend className="atlas-controls__legend">
        <span>多区拼接</span>
        <span className="atlas-controls__count">{regions.length}/{MAX_ATLAS_REGIONS}</span>
      </legend>
      {regions.length > 0 && (
        <ol className="atlas-controls__regions" aria-label="已添加选区">
          {regions.map((region, index) => (
            <li className="atlas-controls__region" key={region.id}>
              <span>{index + 1}</span>
              <span>{region.sourceWidth}×{region.sourceHeight}</span>
              <button
                type="button"
                className="atlas-controls__remove"
                onClick={() => onRemove(region.id)}
                title={`移除选区 ${index + 1}`}
                aria-label={`移除选区 ${index + 1}`}
              >
                ×
              </button>
            </li>
          ))}
        </ol>
      )}
      <div className="atlas-controls__actions">
        <button
          type="button"
          className="btn btn--secondary"
          onClick={onAdd}
          disabled={locked || regions.length >= MAX_ATLAS_REGIONS}
        >
          添加选区
        </button>
        <button
          type="button"
          className="btn btn--ghost"
          onClick={onClear}
          disabled={locked || regions.length === 0}
        >
          清空
        </button>
        <button
          type="button"
          className="btn btn--primary atlas-controls__run"
          onClick={onRun}
          disabled={locked || regions.length === 0 || provider !== "gemini"}
          title={provider === "gemini" ? "一次处理全部选区" : "请先切换到 Gemini 图像引擎"}
        >
          {stopping ? "正在恢复" : running ? "拼接中" : "一次生成"}
        </button>
      </div>
    </fieldset>
  );
};

export default MultiRegionAtlasControls;
