import type { SceneOptionSelection, ScenePack } from "../services/scenePacks";

interface Props {
  packs: ScenePack[];
  selectedPackId: string;
  selection: SceneOptionSelection;
  prompt: string;
  errors: string[];
  provider: "gemini" | "forge";
  running: boolean;
  disabled?: boolean;
  stopping: boolean;
  protectSubject: boolean;
  useSelectionReference: boolean;
  canUndo: boolean;
  onSelectPack: (id: string) => void;
  onChangeOption: (groupId: string, values: string[]) => void;
  onProtectSubjectChange: (value: boolean) => void;
  onUseSelectionReferenceChange: (value: boolean) => void;
  onRun: () => void;
  onUndo: () => void;
}

const ScenePackControls = ({
  packs, selectedPackId, selection, prompt, errors, provider, running, disabled = false, stopping,
  protectSubject, useSelectionReference, canUndo, onSelectPack, onChangeOption,
  onProtectSubjectChange, onUseSelectionReferenceChange, onRun, onUndo
}: Props) => {
  const pack = packs.find((candidate) => candidate.id === selectedPackId) ?? null;
  const controlsDisabled = disabled || running || stopping;
  return (
    <section className="scene-pack" aria-label="场景包">
      <div className="scene-pack__header">
        <span className="scene-pack__title">场景包</span>
        <span className="scene-pack__provider">Gemini</span>
      </div>
      <select
        className="input scene-pack__select"
        aria-label="选择场景包"
        value={selectedPackId}
        disabled={controlsDisabled || !packs.length}
        onChange={(event) => onSelectPack(event.target.value)}
      >
        {!packs.length && <option value="">没有可用场景包</option>}
        {packs.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
      </select>
      {pack && (
        <div className="scene-pack__options">
          {pack.options.map((group) => group.multiple ? (
            <fieldset key={group.id} className="scene-pack__multi" disabled={controlsDisabled}>
              <legend>{group.label}</legend>
              <div className="scene-pack__checks">
                {group.values.map((value) => {
                  const checked = (selection[group.id] ?? []).includes(value.id);
                  return (
                    <label key={value.id}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(event) => {
                          const current = selection[group.id] ?? [];
                          onChangeOption(group.id, event.target.checked
                            ? [...current, value.id]
                            : current.filter((id) => id !== value.id));
                        }}
                      />
                      <span>{value.label}</span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          ) : (
            <label key={group.id} className="scene-pack__field">
              <span>{group.label}</span>
              <select
                className="input"
                value={selection[group.id]?.[0] ?? ""}
                disabled={controlsDisabled}
                onChange={(event) => onChangeOption(group.id, event.target.value ? [event.target.value] : [])}
              >
                {!group.required && <option value="">不使用</option>}
                {group.values.map((value) => <option key={value.id} value={value.id}>{value.label}</option>)}
              </select>
            </label>
          ))}
        </div>
      )}
      <div className="scene-pack__toggles">
        <label>
          <input type="checkbox" checked={protectSubject} disabled={controlsDisabled}
            onChange={(event) => onProtectSubjectChange(event.target.checked)} />
          <span>保护选区主体</span>
        </label>
        <label>
          <input type="checkbox" checked={useSelectionReference} disabled={controlsDisabled}
            onChange={(event) => onUseSelectionReferenceChange(event.target.checked)} />
          <span>选区作人物参考</span>
        </label>
      </div>
      <textarea className="input input--multiline scene-pack__preview" aria-label="场景提示词预览"
        value={prompt} readOnly rows={3} />
      {errors.length > 0 && <div className="scene-pack__error">{errors[0]}</div>}
      <div className="scene-pack__actions">
        <button type="button" className="btn btn--primary"
          disabled={controlsDisabled || provider !== "gemini" || !pack || errors.length > 0} onClick={onRun}>
          {stopping ? "恢复中" : running ? "场景生成中" : "生成场景"}
        </button>
        <button type="button" className="btn btn--ghost" disabled={controlsDisabled || !canUndo} onClick={onUndo}>
          撤销场景
        </button>
      </div>
    </section>
  );
};

export default ScenePackControls;
