import { sanitizePrompt } from "./promptParams";

export interface SceneOptionValue {
  id: string;
  label: string;
  prompt: string;
}

export interface SceneOptionGroup {
  id: string;
  label: string;
  multiple: boolean;
  required: boolean;
  values: SceneOptionValue[];
  defaultValue: string[];
}

export interface ScenePack {
  id: string;
  name: string;
  description?: string;
  promptTemplate: string;
  placeholders: string[];
  options: SceneOptionGroup[];
}

export type SceneOptionSelection = Record<string, string[]>;

export interface ScenePromptResolution {
  prompt: string;
  errors: string[];
}

const sceneModules = import.meta.glob("../assets/scenes/**/*.json", {
  eager: true,
  import: "default"
}) as Record<string, unknown>;

const MAX_PACKS = 64;
const MAX_GROUPS = 16;
const MAX_VALUES_PER_GROUP = 64;
const MAX_TEMPLATE_LENGTH = 4_000;
const ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const VALUE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PLACEHOLDER_PATTERN = /\{([a-z][a-z0-9_-]{0,63})\}/g;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const cleanText = (value: unknown, maxLength: number) =>
  typeof value === "string" ? value.trim().slice(0, maxLength) : "";

const defaultGroupLabel = (id: string) => ({
  lighting: "灯光",
  lens: "焦段",
  props: "道具"
}[id] ?? id);

const normalizeValue = (value: unknown, index: number): SceneOptionValue | null => {
  if (typeof value === "string") {
    const prompt = cleanText(value, 300);
    if (!prompt || /[{}]/.test(prompt)) return null;
    return { id: `option-${index + 1}`, label: prompt, prompt };
  }
  if (!isRecord(value)) return null;
  const prompt = cleanText(value.prompt ?? value.value, 300);
  const label = cleanText(value.label, 80) || prompt;
  const id = cleanText(value.id, 64) || `option-${index + 1}`;
  if (!VALUE_ID_PATTERN.test(id) || !label || !prompt || /[{}]/.test(prompt)) return null;
  return { id, label, prompt };
};

const normalizeDefault = (
  raw: unknown,
  values: SceneOptionValue[],
  multiple: boolean,
  required: boolean
) => {
  const candidates = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  const allowed = new Set(values.map(({ id }) => id));
  const selected = candidates
    .filter((value): value is string => typeof value === "string" && allowed.has(value))
    .slice(0, multiple ? values.length : 1);
  if (selected.length) return Array.from(new Set(selected));
  return required && values.length ? [values[0].id] : [];
};

const normalizeGroup = (id: string, raw: unknown): SceneOptionGroup | null => {
  if (!ID_PATTERN.test(id)) return null;
  const legacyValues = Array.isArray(raw) ? raw : null;
  const structured = isRecord(raw) ? raw : null;
  const rawValues = legacyValues ?? (Array.isArray(structured?.values) ? structured.values : null);
  if (!rawValues?.length || rawValues.length > MAX_VALUES_PER_GROUP) return null;
  const values = rawValues.map(normalizeValue);
  if (values.some((value) => !value)) return null;
  const normalizedValues = values as SceneOptionValue[];
  if (new Set(normalizedValues.map(({ id: valueId }) => valueId)).size !== normalizedValues.length) return null;
  const multiple = structured?.multiple === true || (legacyValues !== null && id === "props");
  const required = structured?.required === false ? false : !multiple;
  return {
    id,
    label: cleanText(structured?.label, 80) || defaultGroupLabel(id),
    multiple,
    required,
    values: normalizedValues,
    defaultValue: normalizeDefault(structured?.defaultValue, normalizedValues, multiple, required)
  };
};

export const parseSceneTemplate = (template: string) => {
  const placeholders: string[] = [];
  const seen = new Set<string>();
  let cursor = 0;
  let match: RegExpExecArray | null;
  PLACEHOLDER_PATTERN.lastIndex = 0;
  while ((match = PLACEHOLDER_PATTERN.exec(template))) {
    const outside = template.slice(cursor, match.index);
    if (outside.includes("{") || outside.includes("}")) {
      return { placeholders: [], error: "场景提示词包含无效占位符" };
    }
    if (!seen.has(match[1])) {
      seen.add(match[1]);
      placeholders.push(match[1]);
    }
    cursor = match.index + match[0].length;
  }
  const tail = template.slice(cursor);
  if (tail.includes("{") || tail.includes("}")) {
    return { placeholders: [], error: "场景提示词包含无效占位符" };
  }
  return { placeholders, error: null };
};

export const normalizeScenePack = (value: unknown): ScenePack | null => {
  if (!isRecord(value)) return null;
  const id = cleanText(value.id, 64);
  const name = cleanText(value.name, 80);
  const description = cleanText(value.description, 240) || undefined;
  const promptTemplate = cleanText(value.promptTemplate, MAX_TEMPLATE_LENGTH);
  if (!ID_PATTERN.test(id) || !name || !promptTemplate || !isRecord(value.options)) return null;
  const parsed = parseSceneTemplate(promptTemplate);
  if (parsed.error || !parsed.placeholders.length || parsed.placeholders.length > MAX_GROUPS) return null;
  const optionEntries = Object.entries(value.options);
  if (optionEntries.length !== parsed.placeholders.length || optionEntries.length > MAX_GROUPS) return null;
  const groups = optionEntries.map(([groupId, raw]) => normalizeGroup(groupId, raw));
  if (groups.some((group) => !group)) return null;
  const options = groups as SceneOptionGroup[];
  const groupIds = new Set(options.map(({ id: groupId }) => groupId));
  if (parsed.placeholders.some((placeholder) => !groupIds.has(placeholder))) return null;
  return { id, name, description, promptTemplate, placeholders: parsed.placeholders, options };
};

const bundledScenePacks: ScenePack[] = [];
const bundledIds = new Set<string>();
for (const [path, raw] of Object.entries(sceneModules).slice(0, MAX_PACKS)) {
  const scene = normalizeScenePack(raw);
  if (!scene || bundledIds.has(scene.id)) {
    console.warn(`Ignored invalid or duplicate scene pack ${path}`);
    continue;
  }
  bundledIds.add(scene.id);
  bundledScenePacks.push(scene);
}
bundledScenePacks.sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));

export const listScenePacks = (): ScenePack[] => bundledScenePacks;

export const createSceneSelection = (pack: ScenePack): SceneOptionSelection =>
  Object.fromEntries(pack.options.map((group) => [group.id, [...group.defaultValue]]));

export const resolveScenePrompt = (
  pack: ScenePack,
  selection: SceneOptionSelection
): ScenePromptResolution => {
  const errors: string[] = [];
  const replacements = new Map<string, string>();
  for (const group of pack.options) {
    const selectedIds = Array.isArray(selection[group.id]) ? selection[group.id] : [];
    const uniqueIds = Array.from(new Set(selectedIds));
    const allowed = new Map(group.values.map((value) => [value.id, value]));
    if (!group.multiple && uniqueIds.length > 1) errors.push(`${group.label}只能选择一项`);
    if (group.required && uniqueIds.length === 0) errors.push(`请选择${group.label}`);
    const invalidIds = uniqueIds.filter((id) => !allowed.has(id));
    if (invalidIds.length) errors.push(`${group.label}包含无效选项`);
    const prompts = uniqueIds.flatMap((id) => allowed.get(id)?.prompt ?? []);
    replacements.set(group.id, prompts.join(", "));
  }
  if (errors.length) return { prompt: "", errors };
  const prompt = sanitizePrompt(pack.promptTemplate
    .replace(PLACEHOLDER_PATTERN, (_match, id: string) => replacements.get(id) ?? "")
    .replace(/[ \t]+/g, " ")
    .replace(/\s+([,.;，。；])/g, "$1")
    .trim());
  const unresolved = parseSceneTemplate(prompt);
  if (unresolved.error || unresolved.placeholders.length) {
    return { prompt: "", errors: ["场景提示词仍包含未解析占位符"] };
  }
  return { prompt, errors: [] };
};
