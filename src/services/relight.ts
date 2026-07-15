export type RelightLightType = "softbox" | "spot" | "area" | "sun";
export type RelightRole = "key" | "fill" | "rim" | "back" | "side";

export interface RelightLight {
  id: string;
  type: RelightLightType;
  role: RelightRole;
  x: number;
  y: number;
  direction: number;
  intensity: number;
  temperature: number;
}

export interface RelightConfig {
  lights: RelightLight[];
}

export const RELIGHT_LIGHT_TYPE_LABELS: Record<RelightLightType, string> = {
  softbox: "柔光箱",
  spot: "聚光灯",
  area: "面光",
  sun: "平行光"
};

export const RELIGHT_ROLE_LABELS: Record<RelightRole, string> = {
  key: "主光",
  fill: "补光",
  rim: "轮廓光",
  back: "背光",
  side: "侧光"
};

const ROLE_PROMPTS: Record<RelightRole, string> = {
  key: "key light",
  fill: "fill light",
  rim: "rim light",
  back: "back light",
  side: "side light"
};

const TYPE_PROMPTS: Record<RelightLightType, string> = {
  softbox: "large softbox",
  spot: "focused spotlight",
  area: "broad area light",
  sun: "parallel sunlight"
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));

export const clampRelightCoordinate = (value: number) => clamp(value, 0, 1);

export const normalizeRelightLight = (light: RelightLight): RelightLight => ({
  ...light,
  x: clampRelightCoordinate(light.x),
  y: clampRelightCoordinate(light.y),
  direction: ((Number.isFinite(light.direction) ? light.direction : 0) % 360 + 360) % 360,
  intensity: clamp(light.intensity, 0, 1),
  temperature: Math.round(clamp(light.temperature, 2000, 10000))
});

export const pointFromStageCoordinates = (
  clientX: number,
  clientY: number,
  bounds: { left: number; top: number; width: number; height: number }
) => ({
  x: clampRelightCoordinate(bounds.width > 0 ? (clientX - bounds.left) / bounds.width : 0.5),
  y: clampRelightCoordinate(bounds.height > 0 ? (clientY - bounds.top) / bounds.height : 0.5)
});

export const relightDirectionVector = (direction: number) => {
  const radians = normalizeRelightLight({
    id: "vector",
    type: "softbox",
    role: "key",
    x: 0,
    y: 0,
    direction,
    intensity: 1,
    temperature: 5600
  }).direction * Math.PI / 180;
  return { x: Math.cos(radians), y: Math.sin(radians) };
};

export const temperatureToCssColor = (temperature: number) => {
  const normalized = (clamp(temperature, 2000, 10000) - 2000) / 8000;
  const red = Math.round(255 - normalized * 88);
  const green = Math.round(145 + normalized * 67);
  const blue = Math.round(72 + normalized * 183);
  return `rgb(${red}, ${green}, ${blue})`;
};

const directionName = (direction: number) => {
  const names = ["right", "down-right", "down", "down-left", "left", "up-left", "up", "up-right"];
  return names[Math.round(normalizeRelightLight({
    id: "direction",
    type: "softbox",
    role: "key",
    x: 0,
    y: 0,
    direction,
    intensity: 1,
    temperature: 5600
  }).direction / 45) % names.length];
};

export const createDefaultRelightLights = (): RelightLight[] => [
  {
    id: "key-1",
    type: "softbox",
    role: "key",
    x: 0.22,
    y: 0.25,
    direction: 35,
    intensity: 0.75,
    temperature: 5200
  },
  {
    id: "rim-1",
    type: "spot",
    role: "rim",
    x: 0.82,
    y: 0.22,
    direction: 145,
    intensity: 0.45,
    temperature: 7000
  }
];

const LIGHT_TYPES = new Set<RelightLightType>(["softbox", "spot", "area", "sun"]);
const LIGHT_ROLES = new Set<RelightRole>(["key", "fill", "rim", "back", "side"]);

export const normalizeRelightConfig = (value: unknown): RelightConfig | null => {
  if (!value || typeof value !== "object" || !Array.isArray((value as RelightConfig).lights)) {
    return null;
  }
  const lights = (value as { lights: unknown[] }).lights.flatMap((candidate, index) => {
    if (!candidate || typeof candidate !== "object") return [];
    const light = candidate as Partial<RelightLight>;
    if (!LIGHT_TYPES.has(light.type as RelightLightType) || !LIGHT_ROLES.has(light.role as RelightRole)) {
      return [];
    }
    return [normalizeRelightLight({
      id: typeof light.id === "string" && light.id ? light.id : `light-${index + 1}`,
      type: light.type as RelightLightType,
      role: light.role as RelightRole,
      x: Number(light.x),
      y: Number(light.y),
      direction: Number(light.direction),
      intensity: Number(light.intensity),
      temperature: Number(light.temperature)
    })];
  });
  return lights.length ? { lights: lights.slice(0, 8) } : null;
};

export const buildRelightPrompt = (lights: RelightLight[], userPrompt = "") => {
  const normalized = lights.map(normalizeRelightLight);
  const lightInstructions = normalized.map((light, index) =>
    `${index + 1}. ${ROLE_PROMPTS[light.role]}, ${TYPE_PROMPTS[light.type]}, origin ` +
    `(${Math.round(light.x * 100)}% from left, ${Math.round(light.y * 100)}% from top), ` +
    `aiming ${directionName(light.direction)} at ${Math.round(light.direction)} degrees, ` +
    `intensity ${light.intensity.toFixed(2)}, color temperature ${light.temperature}K.`
  );
  return [
    "Relight the supplied image using only additive illumination.",
    "Add light and visible light falloff, but do not darken any existing pixel or deepen existing shadows.",
    "Do not change global hue, saturation, luminance, gamma, exposure, contrast, or white balance.",
    "Preserve subject identity, facial features, pose, anatomy, composition, camera perspective, materials, texture, and background geometry exactly.",
    "Do not generate visible lamps, fixtures, stands, arrows, labels, dots, numbers, or annotation marks.",
    "Respect depth, occlusion, cast-light direction, and the existing scene geometry.",
    "Remove any visual annotation traces from the result and return only the naturally relit image.",
    "Lighting plan:",
    ...lightInstructions,
    userPrompt.trim() ? `Additional direction: ${userPrompt.trim()}` : ""
  ].filter(Boolean).join("\n");
};
