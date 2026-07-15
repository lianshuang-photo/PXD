import { useEffect, useState } from "react";
import type { LayoutSnapshot } from "../services/layoutExperience";

interface Props {
  snapshots: LayoutSnapshot[];
  canUndo: boolean;
  busy: boolean;
  error: string | null;
  onSave: (name: string) => Promise<unknown>;
  onApply: (id: string) => Promise<unknown>;
  onDelete: (id: string) => Promise<unknown>;
  onUndo: () => Promise<unknown>;
  onReset: () => Promise<unknown>;
}

const LayoutSnapshotControls = ({
  snapshots,
  canUndo,
  busy,
  error,
  onSave,
  onApply,
  onDelete,
  onUndo,
  onReset
}: Props) => {
  const [name, setName] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (selectedId && snapshots.some((snapshot) => snapshot.id === selectedId)) return;
    setSelectedId(snapshots[0]?.id ?? "");
  }, [selectedId, snapshots]);

  const run = async (action: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await action();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "布局操作失败");
    }
  };

  return (
    <div className="layout-snapshot-controls" aria-label="布局快照" aria-busy={busy}>
      <div className="layout-snapshot-controls__row">
        <input
          className="input"
          value={name}
          maxLength={48}
          placeholder="快照名称"
          aria-label="布局快照名称"
          onChange={(event) => setName(event.target.value)}
        />
        <button
          type="button"
          className="btn btn--secondary"
          disabled={busy || !name.trim()}
          onClick={() => void run(async () => {
            await onSave(name);
            setName("");
          })}
        >
          保存
        </button>
      </div>
      <div className="layout-snapshot-controls__row">
        <select
          className="input"
          value={selectedId}
          aria-label="已保存布局"
          onChange={(event) => setSelectedId(event.target.value)}
        >
          {!snapshots.length && <option value="">暂无快照</option>}
          {snapshots.map((snapshot) => (
            <option key={snapshot.id} value={snapshot.id}>{snapshot.name}</option>
          ))}
        </select>
        <button
          type="button"
          className="btn btn--primary"
          disabled={busy || !selectedId}
          onClick={() => void run(() => onApply(selectedId))}
        >
          应用
        </button>
        <button
          type="button"
          className="btn btn--ghost"
          disabled={busy || !selectedId}
          onClick={() => void run(() => onDelete(selectedId))}
        >
          删除
        </button>
      </div>
      <div className="layout-snapshot-controls__row layout-snapshot-controls__row--commands">
        <button type="button" className="btn btn--ghost" disabled={busy || !canUndo} onClick={() => void run(onUndo)}>
          撤销切换
        </button>
        <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => void run(onReset)}>
          恢复默认
        </button>
        <span className="layout-snapshot-controls__status" role="status">
          {busy ? "正在保存…" : (actionError ?? error ?? "")}
        </span>
      </div>
    </div>
  );
};

export default LayoutSnapshotControls;
