export type VfxEffectType = "sparks" | "smoke" | "fire" | "magic" | "lightning" | "dust";
export type VfxBlendMode = "screen" | "linearDodge";

export interface VfxConfig {
  effectType: VfxEffectType;
  direction: number;
  intensity: number;
  density: number;
  spread: number;
  glow: number;
  color: string;
  useSelectionMask: boolean;
  transparentBackground: boolean;
  blendMode: VfxBlendMode;
}

export const VFX_EFFECT_LABELS: Record<VfxEffectType, string> = {
  sparks: "火花粒子",
  smoke: "烟雾",
  fire: "火焰",
  magic: "魔法能量",
  lightning: "闪电",
  dust: "尘埃粒子"
};

export const VFX_BLEND_LABELS: Record<VfxBlendMode, string> = {
  screen: "滤色",
  linearDodge: "线性减淡"
};

const EFFECT_PROMPTS: Record<VfxEffectType, string> = {
  sparks: "cinematic flying sparks and glowing particles",
  smoke: "cinematic volumetric smoke wisps",
  fire: "cinematic flame and ember effects",
  magic: "cinematic magical energy particles",
  lightning: "cinematic branching lightning arcs",
  dust: "cinematic atmospheric dust particles"
};

const EFFECT_TYPES = new Set<VfxEffectType>(["sparks", "smoke", "fire", "magic", "lightning", "dust"]);
const BLEND_MODES = new Set<VfxBlendMode>(["screen", "linearDodge"]);

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));

const normalizeColor = (value: unknown) => {
  if (typeof value !== "string") return "#ff9f43";
  const color = value.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(color) ? color : "#ff9f43";
};

export const DEFAULT_VFX_CONFIG: VfxConfig = {
  effectType: "sparks",
  direction: 315,
  intensity: 0.7,
  density: 0.55,
  spread: 0.5,
  glow: 0.65,
  color: "#ff9f43",
  useSelectionMask: true,
  transparentBackground: true,
  blendMode: "screen"
};

export const normalizeVfxConfig = (config: VfxConfig): VfxConfig => ({
  ...config,
  direction: ((Number.isFinite(config.direction) ? config.direction : 0) % 360 + 360) % 360,
  intensity: clamp(config.intensity, 0, 1),
  density: clamp(config.density, 0, 1),
  spread: clamp(config.spread, 0, 1),
  glow: clamp(config.glow, 0, 1),
  color: normalizeColor(config.color)
});

export const parseVfxConfig = (value: unknown, options: { strict?: boolean } = {}): VfxConfig | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<VfxConfig>;
  if (!EFFECT_TYPES.has(candidate.effectType as VfxEffectType)) return null;
  if (!BLEND_MODES.has(candidate.blendMode as VfxBlendMode)) return null;
  const numeric = [candidate.direction, candidate.intensity, candidate.density, candidate.spread, candidate.glow];
  if (options.strict && numeric.some((item) => typeof item !== "number" || !Number.isFinite(item))) return null;
  if (options.strict && (typeof candidate.color !== "string" || !/^#[0-9a-f]{6}$/i.test(candidate.color.trim()))) {
    return null;
  }
  if (options.strict && (
    typeof candidate.useSelectionMask !== "boolean" ||
    typeof candidate.transparentBackground !== "boolean"
  )) return null;
  return normalizeVfxConfig({
    effectType: candidate.effectType as VfxEffectType,
    direction: Number(candidate.direction),
    intensity: Number(candidate.intensity),
    density: Number(candidate.density),
    spread: Number(candidate.spread),
    glow: Number(candidate.glow),
    color: normalizeColor(candidate.color),
    useSelectionMask: typeof candidate.useSelectionMask === "boolean"
      ? candidate.useSelectionMask
      : DEFAULT_VFX_CONFIG.useSelectionMask,
    transparentBackground: typeof candidate.transparentBackground === "boolean"
      ? candidate.transparentBackground
      : DEFAULT_VFX_CONFIG.transparentBackground,
    blendMode: candidate.blendMode as VfxBlendMode
  });
};

export const vfxDegreeAdverb = (weight: number) => {
  const normalized = clamp(weight, 0, 1);
  if (normalized < 0.2) return "轻微";
  if (normalized < 0.4) return "较弱";
  if (normalized < 0.6) return "中等";
  if (normalized < 0.8) return "强烈";
  return "极强";
};

const directionName = (direction: number) => {
  const names = ["right", "down-right", "down", "down-left", "left", "up-left", "up", "up-right"];
  const normalized = ((direction % 360) + 360) % 360;
  return names[Math.round(normalized / 45) % names.length];
};

export const buildVfxPrompt = (config: VfxConfig, userPrompt = "") => {
  const normalized = normalizeVfxConfig(config);
  const backgroundInstruction = normalized.transparentBackground
    ? "Return an isolated effect layer with a genuinely transparent alpha background. Do not reproduce the source image as an opaque background."
    : "Return the isolated luminous effect on a perfectly uniform pure-black background suitable for Screen or Linear Dodge blending.";
  const maskInstruction = normalized.useSelectionMask
    ? "Concentrate the effect inside the supplied selected region; the host will apply a non-destructive selection mask, so do not render mask edges."
    : "Allow the effect to extend naturally across the full supplied frame without drawing any mask boundary.";
  return [
    `Generate ${EFFECT_PROMPTS[normalized.effectType]} as a production-ready VFX overlay.`,
    `特效强度：${vfxDegreeAdverb(normalized.intensity)} (${normalized.intensity.toFixed(2)})；` +
      `粒子密度：${vfxDegreeAdverb(normalized.density)} (${normalized.density.toFixed(2)})；` +
      `影响范围：${vfxDegreeAdverb(normalized.spread)} (${normalized.spread.toFixed(2)})；` +
      `发光程度：${vfxDegreeAdverb(normalized.glow)} (${normalized.glow.toFixed(2)})。`,
    `Motion direction: ${directionName(normalized.direction)}, exactly ${Math.round(normalized.direction)} degrees.`,
    `Primary effect color: ${normalized.color}. Keep natural physically plausible falloff and secondary color variation.`,
    backgroundInstruction,
    maskInstruction,
    "Use the supplied image only for composition, depth, scale, lighting, and occlusion reference.",
    "Preserve subject identity, pose, anatomy, composition, camera geometry, and all original image pixels; generate only the requested additive VFX overlay.",
    "Respect foreground and background occlusion. Do not add text, borders, UI, masks, annotations, visible emitters, or unrelated objects.",
    "Keep the exact source dimensions and alignment. Avoid flat stickers, repeated particle stamps, clipped glow, and global color grading.",
    userPrompt.trim() ? `Additional art direction: ${userPrompt.trim()}` : ""
  ].filter(Boolean).join("\n");
};
