export const PROMPT_PARAM_MIN = 0;
export const PROMPT_PARAM_MAX = 1;
export const PROMPT_PARAM_STEP = 0.01;

export interface PromptParamMarker {
  id: string;
  name: string;
  value: number;
  raw: string;
  start: number;
  end: number;
  valueStart: number;
  valueEnd: number;
  syntax: "at" | "bracket";
}

const NUMBER_PATTERN = "[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)";
const PARAM_PATTERN = new RegExp(
  `@param\\s*[:：]\\s*([^:：\\n【】]+?)\\s*[:：]\\s*(${NUMBER_PATTERN})(?![\\d.eE])|` +
  `【\\s*([^:：\\n【】]+?)\\s*[:：]\\s*(${NUMBER_PATTERN})\\s*】`,
  "g"
);

const clampValue = (value: number) => Math.min(PROMPT_PARAM_MAX, Math.max(PROMPT_PARAM_MIN, value));

export const formatPromptParamValue = (value: number) => {
  if (!Number.isFinite(value)) return null;
  return clampValue(value).toFixed(2);
};

export const parsePromptParams = (prompt: string): PromptParamMarker[] => {
  if (!prompt) return [];
  const markers: PromptParamMarker[] = [];
  for (const match of prompt.matchAll(PARAM_PATTERN)) {
    if (match.index === undefined) continue;
    const syntax = match[1] !== undefined ? "at" : "bracket";
    const name = (match[1] ?? match[3] ?? "").trim();
    const valueText = match[2] ?? match[4] ?? "";
    const numericValue = Number(valueText);
    if (!name || !Number.isFinite(numericValue)) continue;
    const valueOffset = match[0].lastIndexOf(valueText);
    if (valueOffset < 0) continue;
    const start = match.index;
    markers.push({
      id: `${syntax}-${start}-${name}`,
      name,
      value: clampValue(numericValue),
      raw: match[0],
      start,
      end: start + match[0].length,
      valueStart: start + valueOffset,
      valueEnd: start + valueOffset + valueText.length,
      syntax
    });
  }
  return markers;
};

export const replacePromptParam = (prompt: string, marker: PromptParamMarker, nextValue: number) => {
  const formatted = formatPromptParamValue(nextValue);
  if (formatted === null || prompt.slice(marker.start, marker.end) !== marker.raw) return prompt;
  return `${prompt.slice(0, marker.valueStart)}${formatted}${prompt.slice(marker.valueEnd)}`;
};

export const sanitizePrompt = (prompt: string) => {
  const zeroMarkers = parsePromptParams(prompt).filter((marker) => marker.value <= PROMPT_PARAM_MIN);
  if (!zeroMarkers.length) return prompt;

  let sanitized = prompt;
  for (const marker of zeroMarkers.reverse()) {
    sanitized = `${sanitized.slice(0, marker.start)}${sanitized.slice(marker.end)}`;
  }
  return sanitized
    .replace(/[ \t]{2,}/g, " ")
    .replace(/([,，;；])(?:\s*[,，;；])+/g, "$1")
    .replace(/^[ \t]*[,，;；]\s*/gm, "")
    .replace(/\s*[,，;；][ \t]*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};
