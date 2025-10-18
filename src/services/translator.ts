const GOOGLE_TRANSLATE_ENDPOINT = "https://translate.googleapis.com/translate_a/single";

const buildUrl = (text: string, source: string, target: string) => {
  const params = new URLSearchParams({
    client: "gtx",
    sl: source,
    tl: target,
    dt: "t",
    q: text
  });
  return `${GOOGLE_TRANSLATE_ENDPOINT}?${params.toString()}`;
};

const extractTranslation = (payload: unknown): string | null => {
  if (!Array.isArray(payload)) return null;
  if (payload.length === 0 || !Array.isArray(payload[0])) return null;
  const segments = payload[0] as unknown[];
  const fragments: string[] = [];
  for (const segment of segments) {
    if (Array.isArray(segment) && typeof segment[0] === "string") {
      fragments.push(segment[0]);
    }
  }
  return fragments.length > 0 ? fragments.join("") : null;
};

export const translateText = async (text: string, source: string, target: string): Promise<string> => {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (source === target) return trimmed;
  try {
    const response = await fetch(buildUrl(trimmed, source, target));
    if (!response.ok) {
      throw new Error(`Translation request failed (${response.status})`);
    }
    const data = await response.json();
    const translated = extractTranslation(data);
    if (translated && translated.trim()) {
      return translated.trim();
    }
    throw new Error("未获取到翻译内容");
  } catch (error) {
    console.warn("translateText error", error);
    throw new Error("翻译服务暂时不可用，请稍后再试");
  }
};
