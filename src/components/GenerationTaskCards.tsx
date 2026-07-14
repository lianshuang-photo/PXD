import type { GenerationTaskSnapshot } from "../services/generationTaskPool";

interface Props {
  tasks: GenerationTaskSnapshot[];
  concurrency: number;
  onCancel: (id: string) => void | Promise<unknown>;
  onRetry: (id: string) => void | Promise<unknown>;
  onReturn: (id: string) => void | Promise<unknown>;
  onRemove: (id: string) => void | Promise<unknown>;
  onExtend: (id: string) => void;
  onAutoReturnChange: (id: string, autoReturn: boolean) => void;
}

const statusLabels: Record<GenerationTaskSnapshot["status"], string> = {
  queued: "排队中",
  running: "生成中",
  returning: "回传中",
  "awaiting-return": "等待回传",
  success: "已完成",
  cancelled: "已停止",
  error: "失败"
};

const engineLabels: Record<GenerationTaskSnapshot["engine"], string> = {
  forge: "Forge",
  gemini: "Gemini"
};

const isActive = (task: GenerationTaskSnapshot) =>
  task.status === "queued" || task.status === "running" || task.status === "returning";

const GenerationTaskCards = ({
  tasks,
  concurrency,
  onCancel,
  onRetry,
  onReturn,
  onRemove,
  onExtend,
  onAutoReturnChange
}: Props) => {
  if (!tasks.length) return null;

  const activeCount = tasks.filter(isActive).length;
  return (
    <section className="generation-tasks" aria-label="生成任务">
      <div className="generation-tasks__header">
        <span>生成任务</span>
        <span>{activeCount} 活跃 · 并发 {concurrency}</span>
      </div>
      <div className="generation-tasks__list">
        {tasks.map((task) => {
          const progress = Math.max(0, Math.min(100, Math.round(task.progress * 100)));
          const canRetry = task.status === "error" || task.status === "cancelled";
          const canRemove = task.status === "awaiting-return" || task.status === "success" ||
            task.status === "error" || task.status === "cancelled";
          return (
            <article className={`generation-task generation-task--${task.status}`} key={task.id}>
              <div className="generation-task__heading">
                <span className="generation-task__title" title={task.title}>{task.title}</span>
                <span className="generation-task__meta">
                  {engineLabels[task.engine]} · {statusLabels[task.status]}
                </span>
              </div>
              <div className="generation-task__progress-row">
                <div className="generation-task__track" aria-label={`进度 ${progress}%`}>
                  <div className="generation-task__fill" style={{ width: `${progress}%` }} />
                </div>
                <span className="generation-task__progress-value">{progress}%</span>
                {task.status === "running" && <span className="generation-task__countdown">{task.countdown}s</span>}
              </div>
              {task.error && <div className="generation-task__error" title={task.error}>{task.error}</div>}
              <div className="generation-task__actions">
                <label className="generation-task__auto-return">
                  <input
                    type="checkbox"
                    checked={task.autoReturn}
                    disabled={task.status === "success"}
                    onChange={(event) => onAutoReturnChange(task.id, event.target.checked)}
                  />
                  自动回传
                </label>
                {task.status === "running" && (
                  <button type="button" className="btn btn--ghost" onClick={() => onExtend(task.id)}>+10s</button>
                )}
                {task.status === "awaiting-return" && (
                  <button type="button" className="btn btn--primary" onClick={() => void onReturn(task.id)}>回传</button>
                )}
                {isActive(task) && (
                  <button type="button" className="btn btn--ghost generation-task__stop" onClick={() => void onCancel(task.id)}>停止</button>
                )}
                {canRetry && (
                  <button type="button" className="btn btn--secondary" onClick={() => void onRetry(task.id)}>重试</button>
                )}
                {canRemove && (
                  <button type="button" className="btn btn--ghost" onClick={() => void onRemove(task.id)}>移除</button>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
};

export default GenerationTaskCards;
