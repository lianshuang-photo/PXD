import { Component, lazy, Suspense, useState, type ErrorInfo, type ReactNode } from "react";
import {
  CAMERA_AZIMUTH_MAX,
  CAMERA_AZIMUTH_MIN,
  CAMERA_AZIMUTH_STEP,
  CAMERA_DISTANCE_MAX,
  CAMERA_DISTANCE_MIN,
  CAMERA_DISTANCE_STEP,
  CAMERA_ELEVATION_MAX,
  CAMERA_ELEVATION_MIN,
  CAMERA_ELEVATION_STEP,
  describeCameraView,
  snapCameraView,
  type CameraViewState
} from "../services/cameraView";

interface Props {
  value: CameraViewState;
  disabled?: boolean;
  running?: boolean;
  onChange: (value: CameraViewState) => void;
  onGenerate: () => void;
}

const CameraViewport = lazy(() => import("./CameraViewport"));

export class CameraViewportBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.warn("Camera viewport failed", error, info.componentStack);
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="camera-view__viewport">
          <div className="camera-view__fallback" role="alert">3D 预览不可用</div>
        </div>
      );
    }
    return this.props.children;
  }
}

const ViewportStatus = ({ children }: { children: ReactNode }) => (
  <div className="camera-view__viewport">
    <div className="camera-view__fallback" role="status">{children}</div>
  </div>
);

const AxisControl = ({
  label,
  value,
  min,
  max,
  step,
  suffix,
  disabled,
  onChange
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix: string;
  disabled?: boolean;
  onChange: (value: number) => void;
}) => (
  <label className="camera-view__axis">
    <span className="camera-view__axis-label">{label}</span>
    <input
      className="camera-view__range"
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      aria-label={label}
      onChange={(event) => onChange(Number(event.target.value))}
    />
    <output className="camera-view__axis-value">{value.toFixed(suffix === "x" ? 1 : 0)}{suffix}</output>
  </label>
);

const CameraViewControl = ({ value, disabled, running, onChange, onGenerate }: Props) => {
  const [expanded, setExpanded] = useState(false);
  const normalized = snapCameraView(value);
  const description = describeCameraView(normalized);
  const setAxis = (axis: keyof CameraViewState, next: number) => onChange(snapCameraView({ ...normalized, [axis]: next }));
  return (
    <section className="camera-view" aria-labelledby="camera-view-title">
      <div className="camera-view__header">
        <div>
          <h3 id="camera-view-title">3D 机位</h3>
          <span className="camera-view__description">{description.zh}</span>
        </div>
        <div className="camera-view__actions">
          <button
            type="button"
            className="btn btn--ghost camera-view__toggle"
            aria-expanded={expanded}
            aria-controls="camera-view-controls"
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? "收起" : "展开"}
          </button>
          <button
            type="button"
            className="btn btn--primary camera-view__generate"
            disabled={disabled || running}
            onClick={onGenerate}
          >
            {running ? "生成中" : "重设机位"}
          </button>
        </div>
      </div>
      {expanded && (
        <div id="camera-view-controls" className="camera-view__body">
          <CameraViewportBoundary>
            <Suspense fallback={<ViewportStatus>正在加载 3D 预览</ViewportStatus>}>
              <CameraViewport value={normalized} disabled={disabled || running} onChange={onChange} />
            </Suspense>
          </CameraViewportBoundary>
          <div className="camera-view__axes">
            <AxisControl
              label="方位"
              value={normalized.azimuth}
              min={CAMERA_AZIMUTH_MIN}
              max={CAMERA_AZIMUTH_MAX}
              step={CAMERA_AZIMUTH_STEP}
              suffix="°"
              disabled={disabled || running}
              onChange={(next) => setAxis("azimuth", next)}
            />
            <AxisControl
              label="仰角"
              value={normalized.elevation}
              min={CAMERA_ELEVATION_MIN}
              max={CAMERA_ELEVATION_MAX}
              step={CAMERA_ELEVATION_STEP}
              suffix="°"
              disabled={disabled || running}
              onChange={(next) => setAxis("elevation", next)}
            />
            <AxisControl
              label="距离"
              value={normalized.distance}
              min={CAMERA_DISTANCE_MIN}
              max={CAMERA_DISTANCE_MAX}
              step={CAMERA_DISTANCE_STEP}
              suffix="x"
              disabled={disabled || running}
              onChange={(next) => setAxis("distance", next)}
            />
          </div>
        </div>
      )}
    </section>
  );
};

export default CameraViewControl;
