import { useEffect, useMemo, type ReactNode } from "react";
import { createPortal } from "react-dom";

const OVERLAY_ROOT_ID = "pxd-overlay-root";

interface OverlayRootHandle {
  element: HTMLElement;
  created: boolean;
}

const ensureOverlayRoot = (): OverlayRootHandle | null => {
  if (typeof document === "undefined") {
    return null;
  }
  const existing = document.getElementById(OVERLAY_ROOT_ID);
  if (existing instanceof HTMLElement) {
    return { element: existing, created: false };
  }
  const root = document.createElement("div");
  root.id = OVERLAY_ROOT_ID;
  root.className = "overlay-root";
  document.body.appendChild(root);
  return { element: root, created: true };
};

interface OverlayPortalProps {
  children: ReactNode;
}

const OverlayPortal = ({ children }: OverlayPortalProps) => {
  const container = useMemo(() => {
    if (typeof document === "undefined") {
      return null;
    }
    const element = document.createElement("div");
    element.className = "overlay-layer";
    return element;
  }, []);

  useEffect(() => {
    const handle = ensureOverlayRoot();
    if (!handle || !container) {
      return;
    }
    const { element: root, created } = handle;
    root.appendChild(container);
    return () => {
      root.removeChild(container);
      if (created && !root.childElementCount) {
        root.remove();
      }
    };
  }, [container]);

  if (!container) {
    return null;
  }

  return createPortal(children, container);
};

export default OverlayPortal;
