import { bridge } from "./uxpBridge";

export interface CameraViewState {
  azimuth: number;
  elevation: number;
  distance: number;
}

export interface CameraPosition {
  x: number;
  y: number;
  z: number;
}

export const CAMERA_VIEW_STORAGE_KEY = "camera-view-state-v1";
export const CAMERA_AZIMUTH_MIN = -180;
export const CAMERA_AZIMUTH_MAX = 180;
export const CAMERA_AZIMUTH_STEP = 45;
export const CAMERA_ELEVATION_MIN = -90;
export const CAMERA_ELEVATION_MAX = 90;
export const CAMERA_ELEVATION_STEP = 15;
export const CAMERA_DISTANCE_MIN = 0.6;
export const CAMERA_DISTANCE_MAX = 4;
export const CAMERA_DISTANCE_STEP = 0.2;

export const DEFAULT_CAMERA_VIEW: CameraViewState = {
  azimuth: 0,
  elevation: 0,
  distance: 2
};

const roundTo = (value: number, digits: number) => Number(value.toFixed(digits));

const snap = (value: number, min: number, max: number, step: number) => {
  const finite = Number.isFinite(value) ? value : min;
  const clamped = Math.min(max, Math.max(min, finite));
  return roundTo(min + Math.round((clamped - min) / step) * step, 4);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const normalizeCameraView = (value: unknown): CameraViewState => {
  if (!isRecord(value)) return { ...DEFAULT_CAMERA_VIEW };
  const azimuth = typeof value.azimuth === "number" && Number.isFinite(value.azimuth)
    ? value.azimuth
    : DEFAULT_CAMERA_VIEW.azimuth;
  const elevation = typeof value.elevation === "number" && Number.isFinite(value.elevation)
    ? value.elevation
    : DEFAULT_CAMERA_VIEW.elevation;
  const distance = typeof value.distance === "number" && Number.isFinite(value.distance)
    ? value.distance
    : DEFAULT_CAMERA_VIEW.distance;
  return {
    azimuth: snap(azimuth, CAMERA_AZIMUTH_MIN, CAMERA_AZIMUTH_MAX, CAMERA_AZIMUTH_STEP),
    elevation: snap(elevation, CAMERA_ELEVATION_MIN, CAMERA_ELEVATION_MAX, CAMERA_ELEVATION_STEP),
    distance: snap(distance, CAMERA_DISTANCE_MIN, CAMERA_DISTANCE_MAX, CAMERA_DISTANCE_STEP)
  };
};

export const snapCameraView = (value: CameraViewState): CameraViewState => normalizeCameraView(value);

export const cameraPositionFor = (value: CameraViewState, radiusScale = 1): CameraPosition => {
  const normalized = normalizeCameraView(value);
  const azimuth = normalized.azimuth * Math.PI / 180;
  const elevation = normalized.elevation * Math.PI / 180;
  const horizontalRadius = normalized.distance * radiusScale * Math.cos(elevation);
  return {
    x: roundTo(horizontalRadius * Math.sin(azimuth), 8),
    y: roundTo(normalized.distance * radiusScale * Math.sin(elevation), 8),
    z: roundTo(horizontalRadius * Math.cos(azimuth), 8)
  };
};

const azimuthCopy = (azimuth: number) => {
  if (azimuth === 0) return { zh: "正面", en: "straight-on front view" };
  if (azimuth === 180 || azimuth === -180) return { zh: "背面", en: "straight-on rear view" };
  const side = azimuth < 0 ? "left" : "right";
  const sideZh = azimuth < 0 ? "左" : "右";
  if (Math.abs(azimuth) === 45) return { zh: `${sideZh}前 3/4`, en: `${side} front three-quarter view` };
  if (Math.abs(azimuth) === 90) return { zh: `${sideZh}侧面`, en: `${side} profile view` };
  return { zh: `${sideZh}后 3/4`, en: `${side} rear three-quarter view` };
};

const elevationCopy = (elevation: number) => {
  if (elevation <= -75) return { zh: "极低机位仰拍", en: "extreme worm's-eye upward angle" };
  if (elevation <= -30) return { zh: "低机位仰拍", en: "dramatic low-angle upward shot" };
  if (elevation < 0) return { zh: "轻微仰拍", en: "slightly low camera angle" };
  if (elevation === 0) return { zh: "平视", en: "eye-level camera angle" };
  if (elevation < 30) return { zh: "轻微俯拍", en: "slightly high camera angle" };
  if (elevation < 75) return { zh: "高机位俯拍", en: "high-angle downward shot" };
  return { zh: "顶视", en: "direct overhead bird's-eye view" };
};

const distanceCopy = (distance: number) => {
  if (distance <= 0.8) return { zh: "大特写", en: "extreme close-up framing" };
  if (distance <= 1.4) return { zh: "特写", en: "close-up framing" };
  if (distance <= 2.2) return { zh: "中景", en: "medium-shot framing" };
  if (distance <= 3.2) return { zh: "远景", en: "long-shot framing" };
  return { zh: "大远景", en: "extreme long-shot framing" };
};

export const describeCameraView = (value: CameraViewState) => {
  const normalized = normalizeCameraView(value);
  const azimuth = azimuthCopy(normalized.azimuth);
  const elevation = elevationCopy(normalized.elevation);
  const distance = distanceCopy(normalized.distance);
  return {
    zh: `${azimuth.zh} · ${elevation.zh} · ${distance.zh}`,
    en: `${azimuth.en}, ${elevation.en}, ${distance.en}`,
    azimuth,
    elevation,
    distance
  };
};

export const buildCameraViewPrompt = (value: CameraViewState) => {
  const normalized = normalizeCameraView(value);
  const description = describeCameraView(normalized);
  return [
    `Reframe the provided image from a ${description.en}.`,
    `Use a virtual camera at ${normalized.azimuth} degrees azimuth, ${normalized.elevation} degrees elevation, and distance ${normalized.distance.toFixed(1)}.`,
    "Preserve the subject's identity, facial features, body proportions, hairstyle, clothing, accessories, colors, materials, pose, and scene continuity.",
    "Change only the camera position, viewing angle, perspective, and framing while keeping the subject clearly recognizable and the original visual style intact.",
    "Do not add, remove, replace, or redesign the subject."
  ].join(" ");
};

export const loadCameraView = async (): Promise<CameraViewState> =>
  normalizeCameraView(await bridge.readPreference<unknown>(CAMERA_VIEW_STORAGE_KEY, DEFAULT_CAMERA_VIEW));

export const saveCameraView = async (value: CameraViewState): Promise<void> => {
  await bridge.writePreference(CAMERA_VIEW_STORAGE_KEY, normalizeCameraView(value));
};
