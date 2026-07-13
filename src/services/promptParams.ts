export const PROMPT_PARAM_MIN = 0;
export const PROMPT_PARAM_MAX = 1;
export const PROMPT_PARAM_STEP = 0.01;

export interface PromptParamMarker {
  id: string;
  name: string;
  rawValue: number;
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
      rawValue: numericValue,
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

export const normalizePromptParams = (prompt: string) => {
  let normalized = prompt;
  for (const marker of parsePromptParams(prompt).reverse()) {
    const formatted = formatPromptParamValue(marker.rawValue);
    if (formatted === null) continue;
    normalized = `${normalized.slice(0, marker.valueStart)}${formatted}${normalized.slice(marker.valueEnd)}`;
  }
  return normalized;
};

const removeMarkerLocally = (prompt: string, marker: PromptParamMarker) => {
  const lineStart = prompt.lastIndexOf("\n", marker.start - 1) + 1;
  const nextNewline = prompt.indexOf("\n", marker.end);
  const lineEnd = nextNewline === -1 ? prompt.length : nextNewline;
  const beforeOnLine = prompt.slice(lineStart, marker.start);
  const afterOnLine = prompt.slice(marker.end, lineEnd);

  if (/^[ \t\r]*$/.test(beforeOnLine) && /^[ \t\r]*$/.test(afterOnLine)) {
    if (lineEnd < prompt.length) {
      return `${prompt.slice(0, lineStart)}${prompt.slice(lineEnd + 1)}`;
    }
    const removalStart = lineStart > 0 ? lineStart - 1 : lineStart;
    return prompt.slice(0, removalStart);
  }

  const after = prompt.slice(marker.end);
  const followingSeparator = after.match(/^[ \t]*[,，;；][ \t]*/)?.[0];
  if (followingSeparator !== undefined) {
    return `${prompt.slice(0, marker.start)}${prompt.slice(marker.end + followingSeparator.length)}`;
  }

  const before = prompt.slice(0, marker.start);
  const precedingSeparator = before.match(/[ \t]*[,，;；][ \t]*$/)?.[0];
  if (precedingSeparator !== undefined) {
    return `${prompt.slice(0, marker.start - precedingSeparator.length)}${prompt.slice(marker.end)}`;
  }

  let removalStart = marker.start;
  let removalEnd = marker.end;
  const precedingWhitespace = before.match(/[ \t]+$/)?.[0];
  const followingWhitespace = after.match(/^[ \t]+/)?.[0];
  if (marker.start === 0 && followingWhitespace) {
    removalEnd += followingWhitespace.length;
  } else if (marker.end === prompt.length && precedingWhitespace) {
    removalStart -= precedingWhitespace.length;
  } else if (precedingWhitespace && followingWhitespace) {
    removalEnd += followingWhitespace.length;
  }
  return `${prompt.slice(0, removalStart)}${prompt.slice(removalEnd)}`;
};

export const sanitizePrompt = (prompt: string) => {
  const normalized = normalizePromptParams(prompt);
  const zeroMarkers = parsePromptParams(normalized).filter((marker) => marker.value <= PROMPT_PARAM_MIN);
  if (!zeroMarkers.length) return normalized;

  let sanitized = normalized;
  for (const marker of zeroMarkers.reverse()) {
    sanitized = removeMarkerLocally(sanitized, marker);
  }
  return sanitized;
};
