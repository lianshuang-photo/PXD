import { useEffect, useRef, useState } from "react";
import type { RecycleBinEntry } from "../services/generationRecycleBin";

interface Props {
  entries: RecycleBinEntry[];
  loading: boolean;
  error: string | null;
  disabled?: boolean;
  onReadPreview: (id: string) => Promise<string | null>;
  onPaste: (id: string) => void | Promise<void>;
  onRerun: (id: string) => void | Promise<void>;
}

const statusLabels: Record<RecycleBinEntry["status"], string> = {
  pending: "生成中",
  success: "可恢复",
  failed: "失败",
  aborted: "已中断"
};

const formatTime = (timestamp: number) => {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const GenerationRecycleBin = ({
  entries,
  loading,
  error,
  disabled = false,
  onReadPreview,
  onPaste,
  onRerun
}: Props) => {
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const requestedRef = useRef(new Set<string>());

  useEffect(() => {
    let current = true;
    const currentIds = new Set(entries.map(({ taskId }) => taskId));
    for (const taskId of requestedRef.current) {
      if (!currentIds.has(taskId)) requestedRef.current.delete(taskId);
    }
    const candidates = entries.filter((entry) =>
      entry.assets.length > 0 && !previews[entry.taskId] && !requestedRef.current.has(entry.taskId)
    );
    for (const entry of candidates) {
      requestedRef.current.add(entry.taskId);
      void onReadPreview(entry.taskId)
        .then((preview) => {
          if (current && preview) setPreviews((previous) => ({ ...previous, [entry.taskId]: preview }));
        })
        .catch(() => undefined);
    }
    return () => {
      current = false;
    };
  }, [entries, onReadPreview, previews]);

  return (
    <section className="generation-recycle-bin" aria-label="生成回收站">
      <div className="generation-history__header">
        <span className="generation-recycle-bin__title">生成回收站</span>
        <span className="generation-history__count">{entries.length}/50</span>
      </div>
      {error && <div className="generation-history__error">{error}</div>}
      {loading ? (
        <div className="generation-history__empty">正在恢复回收站…</div>
      ) : entries.length === 0 ? (
        <div className="generation-history__empty">暂无可恢复任务</div>
      ) : (
        <div className="generation-history__stream">
          {entries.map((entry) => (
            <article className="generation-history__item" key={entry.taskId}>
              {previews[entry.taskId] ? (
                <img
                  className="generation-history__thumbnail"
                  src={previews[entry.taskId]}
                  alt={entry.prompt || "回收站生成结果"}
                />
              ) : (
                <div className="generation-history__thumbnail generation-recycle-bin__placeholder">
                  {entry.assets.length ? "读取中" : "无图片"}
                </div>
              )}
              <div className="generation-history__content">
                <div className="generation-history__prompt" title={entry.prompt}>
                  {entry.prompt || "未命名生成"}
                </div>
                <div className="generation-history__meta">
                  <span>{entry.provider === "forge" ? "Forge" : "Gemini"} · {statusLabels[entry.status]}</span>
                  <span>{formatTime(entry.ts)}</span>
                </div>
                {entry.error && <div className="generation-recycle-bin__error" title={entry.error}>{entry.error}</div>}
                <div className="generation-history__actions">
                  <button
                    type="button"
                    className="btn btn--ghost"
                    disabled={disabled || entry.assets.length === 0}
                    onClick={() => void onPaste(entry.taskId)}
                  >
                    智能贴回
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost"
                    disabled={disabled || (entry.status !== "failed" && entry.status !== "aborted")}
                    onClick={() => void onRerun(entry.taskId)}
                  >
                    重新生成
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
};

export default GenerationRecycleBin;
