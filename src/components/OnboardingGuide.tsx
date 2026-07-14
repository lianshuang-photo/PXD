import { useEffect, useMemo, useRef, useState } from "react";
import OverlayPortal from "./OverlayPortal";

export interface OnboardingStep {
  target: string;
  title: string;
  body: string;
}

export const ONBOARDING_STEPS: OnboardingStep[] = [
  {
    target: "[data-guide='primary-actions']",
    title: "生成操作始终在顶部",
    body: "选好 Photoshop 区域后，可直接生成、加入批次或执行已有批次。"
  },
  {
    target: "[data-guide='layout-controls']",
    title: "保存你的工作布局",
    body: "打开布局工具可保存命名快照、切换布局，并撤销最近一次切换。"
  },
  {
    target: "[data-guide='section-prompts']",
    title: "提示词分区可以移动",
    body: "每个分区都能折叠或上下移动；布局变化会自动持久化。"
  },
  {
    target: "[data-guide='generate-button']",
    title: "可以开始工作了",
    body: "核心生成按钮不会随布局移动，任何时候都保持可用。"
  }
];

interface GuidePosition {
  cardTop: number;
  cardLeft: number;
  cardWidth: number;
  targetTop: number;
  targetLeft: number;
  targetWidth: number;
  targetHeight: number;
}

interface Props {
  open: boolean;
  stepIndex: number;
  onStepChange: (stepIndex: number) => Promise<unknown>;
  onComplete: () => Promise<unknown>;
  onPause: () => void;
  onSkip: () => Promise<unknown>;
  steps?: OnboardingStep[];
}

const OnboardingGuide = ({
  open,
  stepIndex,
  onStepChange,
  onComplete,
  onPause,
  onSkip,
  steps = ONBOARDING_STEPS
}: Props) => {
  const safeIndex = Math.min(Math.max(0, stepIndex), Math.max(0, steps.length - 1));
  const step = steps[safeIndex];
  const [position, setPosition] = useState<GuidePosition | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    queueMicrotask(() => dialogRef.current?.focus());
    return () => previousFocus?.focus();
  }, [open]);

  const locate = useMemo(() => () => {
    if (!open || !step || typeof document === "undefined") {
      setPosition(null);
      return false;
    }
    const target = document.querySelector(step.target) as HTMLElement | null;
    if (!target || typeof target.getBoundingClientRect !== "function") {
      setPosition(null);
      return false;
    }
    target.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    const rect = target.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      setPosition(null);
      return false;
    }
    const viewportWidth = Math.max(1, window.innerWidth || document.documentElement.clientWidth || 320);
    const viewportHeight = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 480);
    const cardWidth = Math.max(1, Math.min(300, viewportWidth - 16));
    const cardHeight = 154;
    const cardTop = rect.bottom + cardHeight + 12 <= viewportHeight
      ? rect.bottom + 8
      : Math.max(8, rect.top - cardHeight - 8);
    const cardLeft = Math.min(
      Math.max(8, rect.left),
      Math.max(8, viewportWidth - cardWidth - 8)
    );
    setPosition({
      cardTop,
      cardLeft,
      cardWidth,
      targetTop: Math.max(2, rect.top - 4),
      targetLeft: Math.max(2, rect.left - 4),
      targetWidth: rect.width + 8,
      targetHeight: rect.height + 8
    });
    return true;
  }, [open, step]);

  useEffect(() => {
    if (!open) return;
    locate();
    const handleViewportChange = () => locate();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onPause();
    };
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [locate, onPause, open]);

  if (!open || !step) return null;

  const run = async (action: () => Promise<unknown>) => {
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "引导进度保存失败");
    } finally {
      setPending(false);
    }
  };

  const isLast = safeIndex === steps.length - 1;
  return (
    <OverlayPortal>
      <div className="onboarding-layer" data-testid="onboarding-layer" style={{ pointerEvents: "none" }}>
        {position && (
          <div
            className="onboarding-spotlight"
            aria-hidden="true"
            style={{
              top: position.targetTop,
              left: position.targetLeft,
              width: position.targetWidth,
              height: position.targetHeight
            }}
          />
        )}
        <div
          ref={dialogRef}
          className="onboarding-guide"
          role="dialog"
          aria-modal="false"
          aria-labelledby="onboarding-guide-title"
          aria-describedby="onboarding-guide-body"
          tabIndex={-1}
          style={{
            top: position?.cardTop ?? 12,
            left: position?.cardLeft ?? 8,
            width: position?.cardWidth ?? "calc(100% - 16px)",
            pointerEvents: "auto"
          }}
        >
          <div className="onboarding-guide__progress" aria-live="polite">
            {safeIndex + 1}/{steps.length}
          </div>
          <h2 id="onboarding-guide-title">{step.title}</h2>
          <p id="onboarding-guide-body">{step.body}</p>
          {!position && (
            <div className="onboarding-guide__validation" role="status">
              当前步骤目标暂不可用。
              <button type="button" className="btn btn--ghost" onClick={locate}>重试</button>
            </div>
          )}
          {error && <div className="onboarding-guide__error" role="alert">{error}</div>}
          <div className="onboarding-guide__actions">
            <button type="button" className="btn btn--ghost" disabled={pending} onClick={onPause}>稍后</button>
            <button type="button" className="btn btn--ghost" disabled={pending} onClick={() => void run(onSkip)}>跳过</button>
            {safeIndex > 0 && (
              <button
                type="button"
                className="btn btn--secondary"
                disabled={pending}
                onClick={() => void run(() => onStepChange(safeIndex - 1))}
              >
                上一步
              </button>
            )}
            <button
              type="button"
              className="btn btn--primary"
              disabled={pending || !position}
              onClick={() => void run(() => isLast ? onComplete() : onStepChange(safeIndex + 1))}
            >
              {isLast ? "完成" : "下一步"}
            </button>
          </div>
        </div>
      </div>
    </OverlayPortal>
  );
};

export default OnboardingGuide;
