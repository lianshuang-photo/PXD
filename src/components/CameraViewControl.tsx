import { Component, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
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
  cameraPositionFor,
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

interface ViewportApi {
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  renderer: THREE.WebGLRenderer;
  render: () => void;
}

class CameraViewportBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.warn("Camera viewport failed", error, info.componentStack);
  }

  render() {
    if (this.state.failed) {
      return <div className="camera-view__viewport camera-view__fallback" role="alert">3D 预览不可用</div>;
    }
    return this.props.children;
  }
}

const SUBJECT_TARGET = new THREE.Vector3(0, 0.85, 0);
const DISTANCE_OFFSET = 1.4;
const DISTANCE_SCALE = 0.8;

const disposeScene = (scene: THREE.Scene) => {
  scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh) && !(object instanceof THREE.Line)) return;
    object.geometry?.dispose();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) material?.dispose();
  });
};

const CameraViewport = ({ value, disabled, onChange }: Pick<Props, "value" | "disabled" | "onChange">) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const apiRef = useRef<ViewportApi | null>(null);
  const valueRef = useRef(value);
  const changeRef = useRef(onChange);
  const [renderError, setRenderError] = useState<string | null>(null);
  valueRef.current = value;
  changeRef.current = onChange;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "low-power" });
    } catch {
      setRenderError("3D 预览不可用");
      return;
    }

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x101319);
    scene.fog = new THREE.Fog(0x101319, 5.5, 8);
    const camera = new THREE.PerspectiveCamera(38, 16 / 9, 0.05, 20);
    const controls = new OrbitControls(camera, canvas);
    controls.target.copy(SUBJECT_TARGET);
    controls.enablePan = false;
    controls.enableDamping = false;
    controls.rotateSpeed = 0.65;
    controls.zoomSpeed = 0.7;
    controls.minDistance = DISTANCE_OFFSET + CAMERA_DISTANCE_MIN * DISTANCE_SCALE;
    controls.maxDistance = DISTANCE_OFFSET + CAMERA_DISTANCE_MAX * DISTANCE_SCALE;
    controls.minPolarAngle = 0.001;
    controls.maxPolarAngle = Math.PI - 0.001;

    const subject = new THREE.Group();
    const darkMaterial = new THREE.MeshStandardMaterial({ color: 0x28313b, roughness: 0.72, metalness: 0.05 });
    const lightMaterial = new THREE.MeshStandardMaterial({ color: 0xd7b56d, roughness: 0.55, metalness: 0.08 });
    const accentMaterial = new THREE.MeshStandardMaterial({ color: 0x4ea6a1, roughness: 0.62, metalness: 0.02 });
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.35, 0.72, 8, 16), darkMaterial);
    torso.position.y = 0.72;
    torso.scale.set(1, 1, 0.72);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.24, 24, 16), lightMaterial);
    head.position.y = 1.48;
    const faceDirection = new THREE.Mesh(new THREE.ConeGeometry(0.065, 0.18, 12), accentMaterial);
    faceDirection.rotation.x = Math.PI / 2;
    faceDirection.position.set(0, 1.48, 0.25);
    subject.add(torso, head, faceDirection);
    scene.add(subject);

    const grid = new THREE.GridHelper(7, 14, 0x47606a, 0x28343d);
    grid.position.y = -0.02;
    scene.add(grid);
    const ringPoints = Array.from({ length: 65 }, (_, index) => {
      const angle = index / 64 * Math.PI * 2;
      return new THREE.Vector3(Math.sin(angle) * 1.3, 0.012, Math.cos(angle) * 1.3);
    });
    const ring = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(ringPoints),
      new THREE.LineBasicMaterial({ color: 0x4ea6a1, transparent: true, opacity: 0.66 })
    );
    scene.add(ring);
    scene.add(new THREE.HemisphereLight(0xf4ead8, 0x1d3540, 2));
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.6);
    keyLight.position.set(2.5, 4, 3);
    scene.add(keyLight);
    const rimLight = new THREE.DirectionalLight(0x65c8c0, 1.8);
    rimLight.position.set(-3, 2, -2);
    scene.add(rimLight);

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    const render = () => renderer.render(scene, camera);
    const resize = () => {
      const width = Math.max(1, canvas.clientWidth || 320);
      const height = Math.max(1, canvas.clientHeight || 180);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
      render();
    };
    const commitOrbit = () => {
      const offset = camera.position.clone().sub(SUBJECT_TARGET);
      const spherical = new THREE.Spherical().setFromVector3(offset);
      const next = snapCameraView({
        azimuth: THREE.MathUtils.radToDeg(spherical.theta),
        elevation: 90 - THREE.MathUtils.radToDeg(spherical.phi),
        distance: (spherical.radius - DISTANCE_OFFSET) / DISTANCE_SCALE
      });
      changeRef.current(next);
    };
    controls.addEventListener("change", render);
    controls.addEventListener("end", commitOrbit);
    const onContextLost = (event: Event) => {
      event.preventDefault();
      setRenderError("3D 预览已暂停");
    };
    canvas.addEventListener("webglcontextlost", onContextLost);
    const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;
    resizeObserver?.observe(canvas);
    window.addEventListener("resize", resize);
    apiRef.current = { camera, controls, renderer, render };
    resize();

    return () => {
      apiRef.current = null;
      resizeObserver?.disconnect();
      window.removeEventListener("resize", resize);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      controls.removeEventListener("change", render);
      controls.removeEventListener("end", commitOrbit);
      controls.dispose();
      disposeScene(scene);
      renderer.dispose();
    };
  }, []);

  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    const normalized = snapCameraView(valueRef.current);
    const radius = DISTANCE_OFFSET + normalized.distance * DISTANCE_SCALE;
    const position = cameraPositionFor(normalized, radius / normalized.distance);
    api.camera.position.set(position.x, position.y + SUBJECT_TARGET.y, position.z);
    api.camera.lookAt(SUBJECT_TARGET);
    api.controls.enabled = !disabled;
    api.controls.update();
    api.render();
  }, [disabled, value]);

  return (
    <div className="camera-view__viewport">
      <canvas
        ref={canvasRef}
        className="camera-view__canvas"
        aria-label="3D 虚拟相机预览"
        title="拖动调整方位和仰角，滚轮调整距离"
      />
      {renderError && <div className="camera-view__fallback" role="status">{renderError}</div>}
    </div>
  );
};

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
        <button
          type="button"
          className="btn btn--primary camera-view__generate"
          disabled={disabled || running}
          onClick={onGenerate}
        >
          {running ? "生成中" : "重设机位"}
        </button>
      </div>
      <CameraViewportBoundary>
        <CameraViewport value={normalized} disabled={disabled || running} onChange={onChange} />
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
    </section>
  );
};

export default CameraViewControl;
