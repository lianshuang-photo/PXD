import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  CAMERA_DISTANCE_MAX,
  CAMERA_DISTANCE_MIN,
  cameraPositionFor,
  snapCameraView,
  type CameraViewState
} from "./services/cameraView";

export interface CameraRuntimeMountOptions {
  canvas: HTMLCanvasElement;
  value: CameraViewState;
  disabled?: boolean;
  onChange: (value: CameraViewState) => void;
  onStatus: (message: string | null) => void;
}

export interface CameraRuntimeHandle {
  update: (value: CameraViewState, disabled?: boolean) => void;
  dispose: () => void;
}

export interface CameraRuntime {
  mount: (options: CameraRuntimeMountOptions) => CameraRuntimeHandle;
}

declare global {
  interface Window {
    __PXD_CAMERA_RUNTIME__?: CameraRuntime;
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

export const mountCameraViewport = ({
  canvas,
  value,
  disabled,
  onChange,
  onStatus
}: CameraRuntimeMountOptions): CameraRuntimeHandle => {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "low-power" });
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
  scene.add(new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(ringPoints),
    new THREE.LineBasicMaterial({ color: 0x4ea6a1, transparent: true, opacity: 0.66 })
  ));
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
  const update = (nextValue: CameraViewState, nextDisabled?: boolean) => {
    const normalized = snapCameraView(nextValue);
    const radius = DISTANCE_OFFSET + normalized.distance * DISTANCE_SCALE;
    const position = cameraPositionFor(normalized, radius / normalized.distance);
    camera.position.set(position.x, position.y + SUBJECT_TARGET.y, position.z);
    camera.lookAt(SUBJECT_TARGET);
    controls.enabled = !nextDisabled;
    controls.update();
    render();
  };
  const commitOrbit = () => {
    const offset = camera.position.clone().sub(SUBJECT_TARGET);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    onChange(snapCameraView({
      azimuth: THREE.MathUtils.radToDeg(spherical.theta),
      elevation: 90 - THREE.MathUtils.radToDeg(spherical.phi),
      distance: (spherical.radius - DISTANCE_OFFSET) / DISTANCE_SCALE
    }));
  };
  controls.addEventListener("change", render);
  controls.addEventListener("end", commitOrbit);
  const onContextLost = (event: Event) => {
    event.preventDefault();
    onStatus("3D 预览已暂停");
  };
  const onContextRestored = () => {
    onStatus(null);
    resize();
  };
  canvas.addEventListener("webglcontextlost", onContextLost);
  canvas.addEventListener("webglcontextrestored", onContextRestored);
  const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;
  resizeObserver?.observe(canvas);
  window.addEventListener("resize", resize);
  resize();
  update(value, disabled);

  return {
    update,
    dispose: () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", resize);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.removeEventListener("webglcontextrestored", onContextRestored);
      controls.removeEventListener("change", render);
      controls.removeEventListener("end", commitOrbit);
      controls.dispose();
      disposeScene(scene);
      renderer.dispose();
    }
  };
};

export const cameraRuntime: CameraRuntime = { mount: mountCameraViewport };

if (typeof window !== "undefined") window.__PXD_CAMERA_RUNTIME__ = cameraRuntime;
