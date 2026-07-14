import { useEffect, useMemo, useState } from "react";
import type { AppSettings } from "../context/types";
import {
  POSTER_WIZARD_STEPS,
  createDefaultPosterDraft,
  getPosterFragments,
  validatePosterDraft,
  type PosterFragmentType,
  type PosterWizardDraft
} from "../services/posterWizard";
import OverlayPortal from "./OverlayPortal";

interface PosterWizardProps {
  provider: AppSettings["imageProvider"];
  running: boolean;
  onGenerate: (draft: PosterWizardDraft) => Promise<boolean>;
  onCancel: () => void;
  onClose: () => void;
}

const ASPECT_RATIO: Record<string, string> = {
  "format-4x5": "4 / 5",
  "format-3x4": "3 / 4",
  "format-square": "1 / 1",
  "format-wide": "16 / 9"
};

const PosterWizard = ({ provider, running, onGenerate, onCancel, onClose }: PosterWizardProps) => {
  const [stepIndex, setStepIndex] = useState(0);
  const [draft, setDraft] = useState(createDefaultPosterDraft);
  const [validationError, setValidationError] = useState<string | null>(null);
  const step = POSTER_WIZARD_STEPS[stepIndex];
  const fragments = useMemo(() => getPosterFragments(step.id), [step.id]);
  const formatRatio = ASPECT_RATIO[draft.selections.format] ?? "4 / 5";
  const composition = draft.selections.composition;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !running) onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, running]);

  const setText = (key: "subject" | "title" | "subtitle" | "details", value: string) => {
    setValidationError(null);
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const setFragment = (type: PosterFragmentType, id: string) => {
    setValidationError(null);
    setDraft((current) => ({
      ...current,
      selections: { ...current.selections, [type]: id }
    }));
  };

  const generate = async () => {
    try {
      validatePosterDraft(draft);
    } catch (caught) {
      setValidationError(caught instanceof Error ? caught.message : "请补全海报参数");
      return;
    }
    setValidationError(null);
    await onGenerate(draft);
  };

  return (
    <OverlayPortal>
      <div className="poster-wizard-backdrop">
        <section
          className="poster-wizard"
          role="dialog"
          aria-modal="true"
          aria-labelledby="poster-wizard-title"
        >
          <header className="poster-wizard__header">
            <h2 id="poster-wizard-title">海报排版向导</h2>
            <button
              type="button"
              className="poster-wizard__close"
              aria-label="关闭海报排版向导"
              onClick={onClose}
              disabled={running}
            >
              ×
            </button>
          </header>

          <nav className="poster-wizard__steps" aria-label="海报生成步骤">
            {POSTER_WIZARD_STEPS.map((candidate, index) => (
              <button
                key={candidate.id}
                type="button"
                className={index === stepIndex ? "poster-wizard__step poster-wizard__step--active" : "poster-wizard__step"}
                aria-current={index === stepIndex ? "step" : undefined}
                onClick={() => setStepIndex(index)}
                disabled={running}
              >
                <span>{index + 1}</span>{candidate.shortLabel}
              </button>
            ))}
          </nav>

          <div className="poster-wizard__body">
            <div className="poster-wizard__editor">
              <h3>{step.label}</h3>
              {step.id === "theme" && (
                <label className="poster-wizard__field">
                  <span>海报主题</span>
                  <input
                    className="input"
                    value={draft.subject}
                    maxLength={120}
                    placeholder="例如：夏日咖啡新品"
                    onChange={(event) => setText("subject", event.target.value)}
                    disabled={running}
                  />
                </label>
              )}
              {step.id === "copy" && (
                <div className="poster-wizard__copy-fields">
                  <label className="poster-wizard__field">
                    <span>主标题</span>
                    <input className="input" value={draft.title} maxLength={60} onChange={(event) => setText("title", event.target.value)} disabled={running} />
                  </label>
                  <label className="poster-wizard__field">
                    <span>副标题</span>
                    <input className="input" value={draft.subtitle} maxLength={120} onChange={(event) => setText("subtitle", event.target.value)} disabled={running} />
                  </label>
                  <label className="poster-wizard__field">
                    <span>补充要求</span>
                    <textarea className="input input--multiline" value={draft.details} maxLength={300} rows={3} onChange={(event) => setText("details", event.target.value)} disabled={running} />
                  </label>
                </div>
              )}

              <fieldset className="poster-wizard__options" disabled={running}>
                <legend>{step.id === "format" ? "画幅" : `${step.label}方向`}</legend>
                {fragments.map((fragment) => (
                  <label key={fragment.id} className={draft.selections[step.id] === fragment.id ? "poster-option poster-option--selected" : "poster-option"}>
                    <input
                      type="radio"
                      name={`poster-${step.id}`}
                      value={fragment.id}
                      checked={draft.selections[step.id] === fragment.id}
                      onChange={() => setFragment(step.id, fragment.id)}
                    />
                    <span>{fragment.label}</span>
                  </label>
                ))}
              </fieldset>
              {validationError && <p className="poster-wizard__error" role="alert">{validationError}</p>}
              {provider !== "gemini" && <p className="poster-wizard__provider" role="status">请先在设置中切换到 Gemini 图像引擎</p>}
            </div>

            <div className="poster-wizard__preview-wrap" aria-label="海报预览">
              <div
                className={`poster-preview poster-preview--${composition.replace("composition-", "")}`}
                style={{ aspectRatio: formatRatio }}
              >
                <div className="poster-preview__subject" aria-hidden="true" />
                <div className="poster-preview__copy">
                  <strong>{draft.title || "主标题"}</strong>
                  <span>{draft.subtitle || draft.subject || "副标题"}</span>
                </div>
                <small>{getPosterFragments("style").find((item) => item.id === draft.selections.style)?.label}</small>
              </div>
            </div>
          </div>

          <footer className="poster-wizard__footer">
            <button type="button" className="btn btn--ghost" onClick={onClose} disabled={running}>取消</button>
            <div className="poster-wizard__nav-actions">
              <button type="button" className="btn btn--secondary" onClick={() => setStepIndex((current) => Math.max(0, current - 1))} disabled={running || stepIndex === 0}>上一步</button>
              {stepIndex < POSTER_WIZARD_STEPS.length - 1 ? (
                <button type="button" className="btn btn--primary" onClick={() => setStepIndex((current) => Math.min(POSTER_WIZARD_STEPS.length - 1, current + 1))} disabled={running}>下一步</button>
              ) : running ? (
                <button type="button" className="btn btn--secondary poster-wizard__stop" onClick={onCancel}>停止生成</button>
              ) : (
                <button type="button" className="btn btn--primary" onClick={generate} disabled={provider !== "gemini"}>生成并贴入 PS</button>
              )}
            </div>
          </footer>
        </section>
      </div>
    </OverlayPortal>
  );
};

export default PosterWizard;
