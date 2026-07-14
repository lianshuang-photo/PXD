import { useEffect, useRef, useState } from "react";
import type { CameraRuntime, CameraRuntimeHandle } from "../cameraRuntime";
import type { CameraViewState } from "../services/cameraView";

interface Props {
  value: CameraViewState;
  disabled?: boolean;
  onChange: (value: CameraViewState) => void;
}

declare global {
  interface Window {
    __PXD_CAMERA_RUNTIME__?: CameraRuntime;
  }
}

const CAMERA_RUNTIME_SRC = "./assets/camera-runtime.js";

export const createRetryableRuntimeLoader = (
  load: () => Promise<CameraRuntime>
) => {
  let pending: Promise<CameraRuntime> | null = null;
  return () => {
    if (!pending) {
      pending = load().catch((error) => {
        pending = null;
        throw error;
      });
    }
    return pending;
  };
};

const loadUncachedCameraRuntime = (): Promise<CameraRuntime> => {
  if (window.__PXD_CAMERA_RUNTIME__) return Promise.resolve(window.__PXD_CAMERA_RUNTIME__);
  if (!import.meta.env.PROD) {
    return import("../cameraRuntime").then(({ cameraRuntime }) => cameraRuntime);
  }
  return new Promise<CameraRuntime>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = CAMERA_RUNTIME_SRC;
    script.async = true;
    script.onload = () => {
      if (window.__PXD_CAMERA_RUNTIME__) resolve(window.__PXD_CAMERA_RUNTIME__);
      else reject(new Error("Camera runtime did not initialize"));
    };
    script.onerror = () => reject(new Error("Camera runtime failed to load"));
    document.head.appendChild(script);
  });
};

const loadCameraRuntime = createRetryableRuntimeLoader(loadUncachedCameraRuntime);

const CameraViewport = ({ value, disabled, onChange }: Props) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const runtimeRef = useRef<CameraRuntimeHandle | null>(null);
  const valueRef = useRef(value);
  const disabledRef = useRef(disabled);
  const changeRef = useRef(onChange);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  valueRef.current = value;
  disabledRef.current = disabled;
  changeRef.current = onChange;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;
    loadCameraRuntime()
      .then((runtime) => {
        if (disposed) return;
        runtimeRef.current = runtime.mount({
          canvas,
          value: valueRef.current,
          disabled: disabledRef.current,
          onChange: (next) => changeRef.current(next),
          onStatus: setRenderError
        });
        setLoading(false);
      })
      .catch(() => {
        if (disposed) return;
        setLoading(false);
        setRenderError("3D 预览不可用");
      });
    return () => {
      disposed = true;
      runtimeRef.current?.dispose();
      runtimeRef.current = null;
    };
  }, []);

  useEffect(() => {
    runtimeRef.current?.update(value, disabled);
  }, [disabled, value]);

  return (
    <div className="camera-view__viewport">
      <canvas
        ref={canvasRef}
        className="camera-view__canvas"
        aria-label="3D 虚拟相机预览"
        title="拖动调整方位和仰角，滚轮调整距离"
      />
      {(loading || renderError) && (
        <div className="camera-view__fallback" role="status">
          {renderError ?? "正在加载 3D 预览"}
        </div>
      )}
    </div>
  );
};

export default CameraViewport;
