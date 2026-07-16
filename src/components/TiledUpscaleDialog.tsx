import { useEffect, useMemo, useState } from "react";
import type { AppSettings } from "../context/types";
import {
  buildTiledUpscalePlan,
  type TiledUpscaleConfig,
  type TiledUpscaleProgress
} from "../services/tiledUpscale";
import OverlayPortal from "./OverlayPortal";

interface Props {
  provider: AppSettings["imageProvider"];
  running: boolean;
  stopping: boolean;
  progress: TiledUpscaleProgress | null;
  sourceSize: { width: number; height: number } | null;
  onInspect: () => Promise<boolean>;
  onRun: (config: TiledUpscaleConfig) => Promise<boolean>;
  onStop: () => void;
  onClose: () => void;
}

const COLORS = ["#22c55e", "#38bdf8", "#f59e0b", "#f472b6", "#a78bfa", "#fb7185"];

const TiledUpscaleDialog = ({
  provider,
  running,
  stopping,
  progress,
  sourceSize,
  onInspect,
  onRun,
  onStop,
  onClose
}: Props) => {
  const [config, setConfig] = useState<TiledUpscaleConfig>({
    scale: 2,
    tileSize: provider === "forge" ? 768 : 1024,
    overlap: 192,
    feather: 96,
    edgeMode: "anchor",
    prompt: "增强真实纹理、微小边缘与材质细节"
  });

  useEffect(() => {
    void onInspect();
  }, [onInspect]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !running) onClose();
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [onClose, running]);

  const preview = useMemo(() => {
    if (!sourceSize) return { plan: null, error: "请读取 Photoshop 选区" };
    try {
      const plan = buildTiledUpscalePlan(sourceSize.width, sourceSize.height, config);
      if (provider === "forge" && config.tileSize * config.scale > 2048) {
        return { plan: null, error: "Forge 单瓦片输出上限为 2048 像素" };
      }
      return { plan, error: null };
    } catch (caught) {
      return { plan: null, error: caught instanceof Error ? caught.message : "参数无效" };
    }
  }, [config, provider, sourceSize]);

  const patchConfig = <K extends keyof TiledUpscaleConfig>(key: K, value: TiledUpscaleConfig[K]) => {
    setConfig((current) => ({ ...current, [key]: value }));
  };

  const percent = progress ? Math.round(progress.completed / progress.total * 100) : 0;

  return (
    <OverlayPortal>
      <div className="tiled-upscale-backdrop">
        <section className="tiled-upscale" role="dialog" aria-modal="true" aria-labelledby="tiled-upscale-title">
          <header className="tiled-upscale__header">
            <h2 id="tiled-upscale-title">分块放大</h2>
            <button type="button" className="tiled-upscale__close" aria-label="关闭分块放大" onClick={onClose} disabled={running}>×</button>
          </header>
          <div className="tiled-upscale__body">
            <div className="tiled-upscale__controls">
              <div className="tiled-upscale__row">
                <label>倍率
                  <select className="input" value={config.scale} disabled={running} onChange={(event) => patchConfig("scale", Number(event.target.value) as 2 | 4)}>
                    <option value={2}>2x</option>
                    <option value={4}>4x</option>
                  </select>
                </label>
                <label>瓦片
                  <select className="input" value={config.tileSize} disabled={running} onChange={(event) => patchConfig("tileSize", Number(event.target.value))}>
                    {[512, 768, 1024, 2048].map((size) => <option key={size} value={size}>{size}px</option>)}
                  </select>
                </label>
              </div>
              <div className="tiled-upscale__row">
                <label>重叠
                  <input className="input" type="number" min={0} max={config.tileSize - 1} step={32} value={config.overlap} disabled={running} onChange={(event) => patchConfig("overlap", Number(event.target.value))} />
                </label>
                <label>羽化
                  <input className="input" type="number" min={0} max={config.overlap} step={16} value={config.feather} disabled={running} onChange={(event) => patchConfig("feather", Number(event.target.value))} />
                </label>
              </div>
              <label className="tiled-upscale__field">边缘处理
                <select className="input" value={config.edgeMode} disabled={running} onChange={(event) => patchConfig("edgeMode", event.target.value as TiledUpscaleConfig["edgeMode"])}>
                  <option value="anchor">贴边整块</option>
                  <option value="partial">边缘小块</option>
                </select>
              </label>
              <label className="tiled-upscale__field">增强提示
                <textarea className="input input--multiline" rows={3} maxLength={500} value={config.prompt} disabled={running} onChange={(event) => patchConfig("prompt", event.target.value)} />
              </label>
              <button type="button" className="btn btn--secondary" onClick={onInspect} disabled={running}>重新读取选区</button>
              {preview.error && <p className="tiled-upscale__error" role="alert">{preview.error}</p>}
            </div>
            <div className="tiled-upscale__preview-panel">
              {sourceSize && preview.plan ? (
                <>
                  <div
                    className="tiled-upscale__preview"
                    style={{ aspectRatio: `${sourceSize.width} / ${sourceSize.height}` }}
                    aria-label={`${preview.plan.columns} 列 ${preview.plan.rows} 行瓦片预览`}
                  >
                    {preview.plan.tiles.map((tile, index) => (
                      <span
                        key={tile.id}
                        className={progress?.tile.id === tile.id ? "tiled-upscale__tile tiled-upscale__tile--active" : "tiled-upscale__tile"}
                        style={{
                          left: `${tile.source.left / sourceSize.width * 100}%`,
                          top: `${tile.source.top / sourceSize.height * 100}%`,
                          width: `${(tile.source.right - tile.source.left) / sourceSize.width * 100}%`,
                          height: `${(tile.source.bottom - tile.source.top) / sourceSize.height * 100}%`,
                          borderColor: COLORS[index % COLORS.length],
                          backgroundColor: `${COLORS[index % COLORS.length]}24`
                        }}
                      >{index + 1}</span>
                    ))}
                  </div>
                  <div className="tiled-upscale__stats">
                    <span>{sourceSize.width}×{sourceSize.height} → {preview.plan.outputWidth}×{preview.plan.outputHeight}</span>
                    <span>{preview.plan.tiles.length} 块 · 工作内存约 {Math.ceil(preview.plan.estimatedWorkingBytes / 1024 / 1024)} MiB</span>
                  </div>
                </>
              ) : <div className="tiled-upscale__empty">未读取选区</div>}
            </div>
          </div>
          {running && (
            <div className="tiled-upscale__progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
              <span style={{ width: `${percent}%` }} />
              <strong>{stopping ? "停止中" : progress ? `${progress.completed}/${progress.total}` : "准备中"}</strong>
            </div>
          )}
          <footer className="tiled-upscale__footer">
            <button type="button" className="btn btn--ghost" onClick={onClose} disabled={running}>取消</button>
            {running ? (
              <button type="button" className="btn btn--secondary tiled-upscale__stop" onClick={onStop} disabled={stopping}>
                {stopping ? "停止中" : "停止"}
              </button>
            ) : (
              <button type="button" className="btn btn--primary" disabled={!preview.plan} onClick={() => onRun(config)}>开始分块放大</button>
            )}
          </footer>
        </section>
      </div>
    </OverlayPortal>
  );
};

export default TiledUpscaleDialog;
