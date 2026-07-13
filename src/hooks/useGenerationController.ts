import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AppSettings } from "../context/types";
import {
  isPxdRequestCancelledError,
  type ControlNetPayload,
  type Img2ImgParams,
  type SdOptions,
  type Txt2ImgParams
} from "../services/apiClient";
import { isImageModelCancelledError } from "../services/imageModelClient";
import {
  formatGenerationError,
  GenerationEngineError,
  type EngineGenerateParams,
  type EngineProgressMode
} from "../services/generationEngine";
import { useGenerationEngine } from "./useGenerationEngine";
import { useEngineLifecycle } from "./useEngineLifecycle";
import {
  executeGenerationTask,
  type GenerationWorkflowResult
} from "../services/generationWorkflow";
import {
  closeDocument,
  closeGeneratedDocument,
  createGeneratedDocument,
  getSelectionPixels,
  groupLayers,
  hasActiveSelection,
  moveActiveLayerToTop,
  onBatchAddLayer,
  placeImageIntoDocument,
  placeImageIntoSelection,
  setSelectionBounds,
  switchToDocument,
  type GeneratedDocumentSession,
  type SelectionPixels
} from "../services/photoshop";
import { clearPSLockQueue, isPSLockControlError } from "../services/psLock";
import {
  deletePresetFile,
  listPresetMetas,
  loadPresetFile,
  savePresetFile,
  type PresetMeta
} from "../services/presets";
import { LatestLoadGate } from "../services/loadGate";
import { GenerationRunGate } from "../services/generationRunGate";
import { translateText } from "../services/translator";
import { useGenerationHistory } from "./useGenerationHistory";
import type { GenerationHistoryEntry } from "../services/generationHistory";
import { normalizePromptParams, sanitizePrompt } from "../services/promptParams";
import {
  REFERENCE_IMAGE_LIMIT,
  REFERENCE_IMAGE_MAX_EDGE,
  appendReferenceImage,
  getReferenceAspectWarning,
  moveReferenceImage as reorderReferenceImage,
  referenceImagesToBase64,
  removeReferenceImage as discardReferenceImage,
  type ReferenceImage
} from "../services/referenceImages";

export type GenerationStatus = "idle" | "running" | "success" | "error";
export type ToastType = "info" | "success" | "warning" | "error";

interface ToastState {
  type: ToastType;
  message: string;
}

export interface GenerationForm {
  positivePrompt: string;
  negativePrompt: string;
  extraPrompt: string;
  steps: number;
  cfgScale: number;
  sampler: string;
  scheduler: string;
  model: string;
  vae: string;
  lora: string;
  loraWeight: number;
  controlNetModel: string;
  controlNetModule: string;
  controlNetWeight: number;
  denoisingStrength: number;
  maskFeather: number;
  imageCount: number;
  resolution: number;
  seed: number;
  clipSkip: number;
  restoreFaces: boolean;
  tiling: boolean;
}

export interface BatchItem {
  id: string;
  name: string;
  createdAt: string;
  form: GenerationForm;
  selection: SelectionPixels;
  overrideWidth: number;
  overrideHeight: number;
  status: "queued" | "running" | "success" | "stopped" | "error";
  error?: string;
  referenceImages: ReferenceImage[];
  referenceAspectWarning?: string;
  metadata?: {
    activeDocumentId?: number;
    batchDocumentId?: number;
    newLayerId?: number;
  };
}

interface PresetPayload {
  form: GenerationForm;
}

interface BatchAddToken {
  generation: number;
  provider: AppSettings["imageProvider"];
  referenceVersion: number;
}

export class GenerationRequestSession {
  readonly controller = new AbortController();
  private retainedReferenceImages: ReferenceImage[] | null = null;
  private retainedBatchItems: BatchItem[] | null = null;

  constructor(
    readonly id: number,
    readonly provider: AppSettings["imageProvider"]
  ) {}

  retainReferenceImages(images: ReferenceImage[]) {
    this.retainedReferenceImages = images;
  }

  retainBatchItems(items: BatchItem[]) {
    this.retainedBatchItems = items;
  }

  get referenceImages() {
    return this.retainedReferenceImages;
  }

  get batchItems() {
    return this.retainedBatchItems;
  }

  clearSensitiveData() {
    this.retainedReferenceImages = null;
    this.retainedBatchItems = null;
  }

  invalidate() {
    this.clearSensitiveData();
    this.controller.abort();
  }
}

class StaleGenerationRequestError extends Error {
  constructor() {
    super("Generation request is no longer current");
    this.name = "StaleGenerationRequestError";
  }
}

const requireReferenceImages = (session: GenerationRequestSession) => {
  if (!session.referenceImages) throw new StaleGenerationRequestError();
  return session.referenceImages;
};

const requireBatchItem = (session: GenerationRequestSession, index: number) => {
  const item = session.batchItems?.[index];
  if (!item) throw new StaleGenerationRequestError();
  return item;
};

const cleanupStaleBatchResources = async (
  docInfo: [number, number, number] | null,
  taskId: string
) => {
  if (!docInfo) return;
  const [activeDocumentId, batchDocumentId, newLayerId] = docInfo;
  const hasValidIds = [activeDocumentId, batchDocumentId, newLayerId]
    .every((value) => Number.isSafeInteger(value) && value > 0);
  if (!hasValidIds || activeDocumentId === batchDocumentId) return;
  await closeDocument(batchDocumentId, activeDocumentId, newLayerId, { taskId }).catch((error) =>
    console.warn("stale batch cleanup failed", error)
  );
};

const EMPTY_OPTIONS: SdOptions = {
  models: [],
  vaes: [],
  loras: [],
  samplers: [],
  schedulers: [],
  controlNetModels: [],
  controlNetModules: []
};

const GENERATION_WORKFLOW_ADAPTERS = {
  placeImage: placeImageIntoSelection,
  groupLayers: (layerIds: number[], groupName: string | undefined, options: { taskId?: string }) =>
    groupLayers(layerIds, groupName, options).catch((error) => {
      ignoreBestEffortPhotoshopError("groupLayers failed", error);
      return null;
    }),
  moveActiveLayerToTop
};

const DEFAULT_FORM: GenerationForm = {
  positivePrompt: "",
  negativePrompt: "",
  extraPrompt: "",
  steps: 20,
  cfgScale: 7,
  sampler: "",
  scheduler: "",
  model: "",
  vae: "",
  lora: "",
  loraWeight: 1,
  controlNetModel: "",
  controlNetModule: "",
  controlNetWeight: 1,
  denoisingStrength: 0.35,
  maskFeather: 20,
  imageCount: 1,
  resolution: 768,
  seed: -1,
  clipSkip: 0,
  restoreFaces: false,
  tiling: false
};

const hydrateHistoryForm = (params: unknown, fallbackPrompt: string): GenerationForm => {
  const restored = { ...DEFAULT_FORM };
  if (params && typeof params === "object" && !Array.isArray(params)) {
    const source = params as Record<string, unknown>;
    for (const key of Object.keys(DEFAULT_FORM) as Array<keyof GenerationForm>) {
      const candidate = source[key];
      const defaultValue = DEFAULT_FORM[key];
      if (typeof candidate !== typeof defaultValue) continue;
      if (typeof candidate === "number" && !Number.isFinite(candidate)) continue;
      (restored as unknown as Record<string, unknown>)[key] = candidate;
    }
  }
  if (!restored.positivePrompt && fallbackPrompt) restored.positivePrompt = fallbackPrompt;
  return restored;
};

const effectivePromptFor = (form: GenerationForm) =>
  [form.positivePrompt, form.extraPrompt].filter(Boolean).join("\n").trim();

const PROMPT_FORM_KEYS = new Set<keyof GenerationForm>([
  "positivePrompt",
  "negativePrompt",
  "extraPrompt"
]);

const normalizePromptFormValue = <K extends keyof GenerationForm>(
  key: K,
  value: GenerationForm[K]
): GenerationForm[K] => (
  PROMPT_FORM_KEYS.has(key) && typeof value === "string"
    ? normalizePromptParams(value) as GenerationForm[K]
    : value
);

const normalizeFormPrompts = (form: GenerationForm): GenerationForm => ({
  ...form,
  positivePrompt: normalizePromptParams(form.positivePrompt),
  negativePrompt: normalizePromptParams(form.negativePrompt),
  extraPrompt: normalizePromptParams(form.extraPrompt)
});

const toDataUrl = (base64: string) => `data:image/png;base64,${base64}`;
const dataUrlToBase64 = (dataUrl: string) => dataUrl.includes(",") ? dataUrl.split(",").pop() ?? dataUrl : dataUrl;

const extractLayerId = (info: unknown): number | null => {
  if (!info || typeof info !== "object") return null;
  const record = info as Record<string, unknown>;
  const candidate = record.layerID ?? record.layerId ?? record.targetLayerID ?? record.targetLayerId ?? record.ID ?? record.id;
  const numeric = Number(candidate);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
};

const computeOverrideSize = (width: number, height: number, target: number) => {
  if (width <= target && height <= target) {
    return { width, height };
  }
  const scale = Math.min(target / width, target / height);
  return {
    width: Math.max(32, Math.round(width * scale)),
    height: Math.max(32, Math.round(height * scale))
  };
};

const normalizeControlNetPayload = (
  form: GenerationForm,
  baseImage: string
): ControlNetPayload | undefined => {
  if (!form.controlNetModel) return undefined;
  return {
    model: form.controlNetModel,
    module: form.controlNetModule || undefined,
    weight: Number.isFinite(form.controlNetWeight) ? form.controlNetWeight : undefined,
    guidanceStart: 0,
    guidanceEnd: 1,
    pixelPerfect: true,
    image: baseImage
  };
};

const createBatchItemName = (form: GenerationForm, index: number) => {
  const summarySource = [form.positivePrompt, form.extraPrompt].filter(Boolean).join(" ").trim();
  if (summarySource.length > 0) {
    return summarySource.split("\n")[0].slice(0, 32);
  }
  return `预设任务 ${index + 1}`;
};

const generateId = () => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
};

const ignoreBestEffortPhotoshopError = (label: string, error: unknown) => {
  if (isPSLockControlError(error)) {
    throw error;
  }
  console.warn(label, error);
};

const isGenerationCancelledError = (error: unknown): boolean =>
  isPxdRequestCancelledError(error) ||
  isImageModelCancelledError(error) ||
  (error instanceof GenerationEngineError && isGenerationCancelledError(error.originalError));

const clampNumber = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const appendPromptValue = (current: string, addition: string) => {
  const trimmedAddition = addition.trim();
  if (!trimmedAddition) {
    return { value: current, appended: false };
  }
  if (!current.trim()) {
    return { value: trimmedAddition, appended: true };
  }
  const currentWithoutTrailingWhitespace = current.replace(/\s+$/, "");
  const separator = /[,，]$/.test(currentWithoutTrailingWhitespace) ? " " : ", ";
  return {
    value: `${currentWithoutTrailingWhitespace}${separator}${trimmedAddition}`,
    appended: true
  };
};

const buildTxt2ImgParams = (
  form: GenerationForm,
  width: number,
  height: number
): Txt2ImgParams => {
  const effectivePrompt = sanitizePrompt(
    [form.positivePrompt, form.extraPrompt].filter(Boolean).join("\n").trim()
  );
  return {
    prompt: effectivePrompt,
    negativePrompt: sanitizePrompt(form.negativePrompt),
    steps: clampNumber(form.steps, 1, 150),
    cfgScale: clampNumber(form.cfgScale, 1, 30),
    sampler: form.sampler || undefined,
    scheduler: form.scheduler || undefined,
    model: form.model || undefined,
    vae: form.vae || undefined,
    loras: form.lora
      ? [{
          name: form.lora,
          weight: Number.isFinite(form.loraWeight) ? clampNumber(form.loraWeight, -2, 2) : 1
        }]
      : undefined,
    batchSize: clampNumber(form.imageCount, 1, 8),
    width,
    height,
    seed: form.seed ?? -1,
    clipSkip: form.clipSkip > 0 ? form.clipSkip : undefined,
    restoreFaces: form.restoreFaces,
    tiling: form.tiling
  };
};

const buildImg2ImgParams = (
  form: GenerationForm,
  baseImage: string,
  width: number,
  height: number
): Img2ImgParams => {
  const effectivePrompt = sanitizePrompt(
    [form.positivePrompt, form.extraPrompt].filter(Boolean).join("\n").trim()
  );
  return {
    prompt: effectivePrompt,
    negativePrompt: sanitizePrompt(form.negativePrompt),
    steps: clampNumber(form.steps, 1, 150),
    cfgScale: clampNumber(form.cfgScale, 1, 30),
    sampler: form.sampler || undefined,
    scheduler: form.scheduler || undefined,
    model: form.model || undefined,
    vae: form.vae || undefined,
    loras: form.lora
      ? [{
          name: form.lora,
          weight: Number.isFinite(form.loraWeight) ? clampNumber(form.loraWeight, -2, 2) : 1
        }]
      : undefined,
    batchSize: clampNumber(form.imageCount, 1, 8),
    width,
    height,
    denoisingStrength: clampNumber(form.denoisingStrength, 0, 0.99),
    seed: form.seed ?? -1,
    clipSkip: form.clipSkip > 0 ? form.clipSkip : undefined,
    restoreFaces: form.restoreFaces,
    tiling: form.tiling,
    controlNet: normalizeControlNetPayload(form, baseImage),
    baseImage
  };
};

const buildEngineGenerateParams = (
  provider: AppSettings["imageProvider"],
  settings: AppSettings,
  form: GenerationForm,
  selection: SelectionPixels | null,
  width: number,
  height: number,
  taskId?: string,
  referenceImages: ReferenceImage[] = [],
  signal?: AbortSignal
): EngineGenerateParams => {
  const prompt = sanitizePrompt(
    [form.positivePrompt, form.extraPrompt].filter(Boolean).join("\n").trim()
  );
  return {
    prompt,
    baseImageBase64: selection ? dataUrlToBase64(selection.dataUrl) : "",
    refImagesBase64: provider === "gemini" ? referenceImagesToBase64(referenceImages) : undefined,
    timeoutMs: Math.max(
      5_000,
      Math.round(settings.timeoutMaxSeconds * 1_000 * settings.timeoutMultiplier)
    ),
    taskId,
    signal,
    forgeParams:
      provider === "forge" && selection
        ? buildImg2ImgParams(form, selection.dataUrl, width, height)
        : undefined,
    forgeTxt2ImgParams:
      provider === "forge" && !selection
        ? buildTxt2ImgParams(form, width, height)
        : undefined
  };
};

export interface GenerationControllerState {
  form: GenerationForm;
  setFormValue: <K extends keyof GenerationForm>(key: K, value: GenerationForm[K]) => void;
  resetForm: () => void;
  setResolution: (value: number) => void;
  status: GenerationStatus;
  progress: number;
  progressMode: EngineProgressMode;
  progressPreview: string | null;
  progressText: string | null;
  error: string | null;
  lastImages: string[];
  options: SdOptions;
  optionsLoading: boolean;
  optionsError: string | null;
  refreshOptions: () => Promise<void>;
  runGeneration: () => Promise<void>;
  stopGeneration: () => void;
  referenceImages: ReferenceImage[];
  referenceCaptureLoading: boolean;
  referenceAspectWarning: string | null;
  captureReferenceImage: () => Promise<void>;
  removeReferenceImage: (id: string) => void;
  moveReferenceImage: (id: string, direction: "left" | "right") => void;
  clearReferenceImages: () => void;
  history: GenerationHistoryEntry<GenerationForm>[];
  historyLoading: boolean;
  historyError: string | null;
  restoreHistoryConfig: (id: string) => Promise<void>;
  pasteHistoryResult: (id: string) => Promise<void>;
  batchItems: BatchItem[];
  addToBatch: () => Promise<void>;
  removeFromBatch: (id: string) => Promise<void>;
  clearBatch: () => Promise<void>;
  runBatch: () => Promise<void>;
  toast: ToastState | null;
  dismissToast: () => void;
  presets: PresetMeta[];
  selectedPreset: string | null;
  loadPresets: () => Promise<void>;
  applyPreset: (fileName: string) => Promise<void>;
  savePreset: (name: string) => Promise<void>;
  deletePreset: (fileName: string) => Promise<void>;
  setSelectedPreset: (name: string | null) => void;
  pushToast: (type: ToastType, message: string) => void;
  translationInput: string;
  setTranslationInput: (value: string) => void;
  translationResult: string;
  translationError: string | null;
  translationLoading: boolean;
  sourceLanguage: string;
  targetLanguage: string;
  setSourceLanguage: (value: string) => void;
  setTargetLanguage: (value: string) => void;
  runTranslation: () => Promise<void>;
  clearTranslation: () => void;
  appendTranslationToPositive: () => void;
  appendTranslationToNegative: () => void;
  appendExtraPromptToPositive: () => void;
  appendExtraPromptToNegative: () => void;
}

export interface GenerationControllerSettingsActions {
  settingsLoading?: boolean;
  updateSettings?: (next: Pick<AppSettings, "imageProvider">) => Promise<void>;
}

export const useGenerationController = (
  settings: AppSettings,
  settingsActions: GenerationControllerSettingsActions = {}
): GenerationControllerState => {
  const engine = useGenerationEngine(settings);
  const {
    token: engineToken,
    isCurrent: isEngineCurrent,
    commitIfCurrent,
    startPolling,
    stopPolling
  } = useEngineLifecycle(engine);
  const [form, setForm] = useState<GenerationForm>(DEFAULT_FORM);
  const [status, setStatus] = useState<GenerationStatus>("idle");
  const [progress, setProgress] = useState(0);
  const [progressPreview, setProgressPreview] = useState<string | null>(null);
  const [progressText, setProgressText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastImages, setLastImages] = useState<string[]>([]);
  const [options, setOptions] = useState<SdOptions>(EMPTY_OPTIONS);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [referenceImages, setReferenceImages] = useState<ReferenceImage[]>([]);
  const [referenceCaptureLoading, setReferenceCaptureLoading] = useState(false);
  const [referenceAspectWarning, setReferenceAspectWarning] = useState<string | null>(null);
  const [batchItems, setBatchItems] = useState<BatchItem[]>([]);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [presets, setPresets] = useState<PresetMeta[]>([]);
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);
  const [translationInput, setTranslationInputState] = useState("");
  const [translationResult, setTranslationResult] = useState("");
  const [translationError, setTranslationError] = useState<string | null>(null);
  const [translationLoading, setTranslationLoading] = useState(false);
  const [sourceLanguage, setSourceLanguage] = useState("zh");
  const [targetLanguage, setTargetLanguage] = useState("en");
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const presetsLoadGateRef = useRef(new LatestLoadGate());
  const referenceImagesRef = useRef<ReferenceImage[]>([]);
  const referenceImagesVersionRef = useRef(0);
  const referenceCaptureGenerationRef = useRef(0);
  const referenceCaptureLoadingRef = useRef(false);
  const batchItemsRef = useRef<BatchItem[]>([]);
  const batchAddGenerationRef = useRef(0);
  const providerRef = useRef(settings.imageProvider);
  const generationRequestRef = useRef(0);
  const activeGenerationRequestRef = useRef<GenerationRequestSession | null>(null);
  const settingsRef = useRef(settings);
  const historyRestoreGenerationRef = useRef(0);
  const historyRestoreQueueRef = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);
  const runGateRef = useRef(new GenerationRunGate());
  const stoppedByEngineChangeRef = useRef(false);

  const commitReferenceImages = useCallback((next: ReferenceImage[]) => {
    referenceImagesVersionRef.current += 1;
    referenceImagesRef.current = next;
    setReferenceImages(next);
    setReferenceAspectWarning(null);
  }, []);
  const commitBatchItems = useCallback((update: BatchItem[] | ((current: BatchItem[]) => BatchItem[])) => {
    const next = typeof update === "function" ? update(batchItemsRef.current) : update;
    batchItemsRef.current = next;
    setBatchItems(next);
  }, []);
  const invalidateReferenceCapture = useCallback(() => {
    referenceCaptureGenerationRef.current += 1;
    referenceCaptureLoadingRef.current = false;
    setReferenceCaptureLoading(false);
  }, []);
  const invalidateGenerationRequest = useCallback(() => {
    generationRequestRef.current += 1;
    activeGenerationRequestRef.current?.invalidate();
    activeGenerationRequestRef.current = null;
  }, []);
  const beginGenerationRequest = useCallback((provider: AppSettings["imageProvider"]) => {
    activeGenerationRequestRef.current?.invalidate();
    const session = new GenerationRequestSession(generationRequestRef.current + 1, provider);
    generationRequestRef.current = session.id;
    activeGenerationRequestRef.current = session;
    return session;
  }, []);
  const isGenerationSessionCurrent = useCallback((session: GenerationRequestSession) =>
    activeGenerationRequestRef.current === session &&
    generationRequestRef.current === session.id &&
    providerRef.current === session.provider &&
    !session.controller.signal.aborted, []);
  const finishGenerationRequest = useCallback((session: GenerationRequestSession) => {
    session.clearSensitiveData();
    if (activeGenerationRequestRef.current === session) activeGenerationRequestRef.current = null;
  }, []);
  const invalidateBatchAdds = useCallback(() => {
    batchAddGenerationRef.current += 1;
  }, []);
  const beginBatchAdd = useCallback((): BatchAddToken => ({
    generation: batchAddGenerationRef.current,
    provider: providerRef.current,
    referenceVersion: referenceImagesVersionRef.current
  }), []);
  const isBatchAddCurrent = useCallback((token: BatchAddToken) =>
    batchAddGenerationRef.current === token.generation &&
    providerRef.current === token.provider &&
    referenceImagesVersionRef.current === token.referenceVersion, []);

  useLayoutEffect(() => {
    providerRef.current = settings.imageProvider;
    invalidateBatchAdds();
    invalidateGenerationRequest();
    setProgress(0);
    setStatus((current) => current === "running" ? "idle" : current);
    if (settings.imageProvider !== "gemini") {
      invalidateReferenceCapture();
      commitReferenceImages([]);
      commitBatchItems((items) => items.map((item) =>
        item.referenceImages.length
          ? { ...item, referenceImages: [], referenceAspectWarning: undefined }
          : item
      ));
    }
  }, [commitBatchItems, commitReferenceImages, engineToken, invalidateBatchAdds, invalidateGenerationRequest, invalidateReferenceCapture, settings.imageProvider]);

  useLayoutEffect(() => () => {
    invalidateBatchAdds();
    invalidateGenerationRequest();
    invalidateReferenceCapture();
    referenceImagesRef.current = [];
    batchItemsRef.current = [];
  }, [invalidateBatchAdds, invalidateGenerationRequest, invalidateReferenceCapture]);

  useEffect(() => () => {
    if (runGateRef.current.stop()) {
      engine.cancelAll();
      stoppedByEngineChangeRef.current = true;
    }
    invalidateGenerationRequest();
  }, [engine, invalidateGenerationRequest]);
  const clearToastTimer = useCallback(() => {
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
  }, []);
  const pushToast = useCallback((type: ToastType, message: string) => {
    setToast({ type, message });
  }, []);
  const {
    entries: history,
    loading: historyLoading,
    error: historyError,
    record: recordHistory
  } = useGenerationHistory<GenerationForm>((message) => pushToast("warning", message));
  const dismissToast = useCallback(() => {
    clearToastTimer();
    setToast(null);
  }, [clearToastTimer]);
  useEffect(() => {
    if (!toast) {
      clearToastTimer();
      return;
    }
    clearToastTimer();
    toastTimerRef.current = setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, 5000);
    return () => {
      clearToastTimer();
    };
  }, [toast, clearToastTimer]);

  useEffect(() => {
    if (!stoppedByEngineChangeRef.current) return;
    stoppedByEngineChangeRef.current = false;
    commitBatchItems((items) =>
      items.map((item) =>
        item.status === "running" ? { ...item, status: "stopped", error: undefined } : item
      )
    );
    setError(null);
    pushToast("info", "设置已更新，当前生成已停止");
  }, [engine, pushToast]);

  const setFormValue = useCallback(
    <K extends keyof GenerationForm>(key: K, value: GenerationForm[K]) => {
      setForm((prev) => ({
        ...prev,
        [key]: normalizePromptFormValue(key, value)
      }));
    },
    []
  );

  const resetForm = useCallback(() => {
    setForm(DEFAULT_FORM);
  }, []);

  const setResolution = useCallback(
    (value: number) => {
      setFormValue("resolution", value);
    },
    [setFormValue]
  );

  const setTranslationInput = useCallback((value: string) => {
    setTranslationError(null);
    setTranslationInputState(value);
  }, []);

  const loadPresets = useCallback(async () => {
    const gate = presetsLoadGateRef.current;
    const generation = gate.begin();
    try {
      const list = await listPresetMetas();
      if (gate.isCurrent(generation)) {
        setPresets(list);
      }
    } finally {
      gate.complete(generation);
    }
  }, []);

  const runTranslation = useCallback(async () => {
    const text = translationInput.trim();
    if (!text) {
      setTranslationError("请输入需要翻译的内容");
      pushToast("warning", "请输入需要翻译的内容");
      return;
    }
    if (sourceLanguage === targetLanguage) {
      setTranslationResult(text);
      pushToast("info", "源语言与目标语言相同，已直接复制文本");
      return;
    }
    setTranslationLoading(true);
    setTranslationError(null);
    try {
      const translated = await translateText(text, sourceLanguage, targetLanguage);
      setTranslationResult(translated);
      pushToast("success", "翻译完成");
    } catch (error) {
      const message = error instanceof Error ? error.message : "翻译失败";
      setTranslationError(message);
      pushToast("error", message);
    } finally {
      setTranslationLoading(false);
    }
  }, [translationInput, sourceLanguage, targetLanguage, pushToast]);

  const clearTranslation = useCallback(() => {
    setTranslationInputState("");
    setTranslationResult("");
    setTranslationError(null);
  }, []);

  const appendTranslationToPositive = useCallback(() => {
    const text = translationResult.trim();
    if (!text) {
      pushToast("warning", "没有可用的翻译内容");
      return;
    }
    setForm((prev) => {
      const { value, appended } = appendPromptValue(prev.positivePrompt, text);
      if (!appended) return prev;
      return {
        ...prev,
        positivePrompt: normalizePromptParams(value)
      };
    });
    pushToast("success", "已添加至正向提示词");
  }, [translationResult, pushToast]);

  const appendTranslationToNegative = useCallback(() => {
    const text = translationResult.trim();
    if (!text) {
      pushToast("warning", "没有可用的翻译内容");
      return;
    }
    setForm((prev) => {
      const { value, appended } = appendPromptValue(prev.negativePrompt, text);
      if (!appended) return prev;
      return {
        ...prev,
        negativePrompt: normalizePromptParams(value)
      };
    });
    pushToast("success", "已添加至反向提示词");
  }, [translationResult, pushToast]);

  const appendExtraPromptToPositive = useCallback(() => {
    const extra = form.extraPrompt.trim();
    if (!extra) {
      pushToast("warning", "请输入追加提示词");
      return;
    }
    setForm((prev) => {
      const { value } = appendPromptValue(prev.positivePrompt, extra);
      return {
        ...prev,
        positivePrompt: normalizePromptParams(value),
        extraPrompt: ""
      };
    });
    pushToast("success", "已添加至正向提示词");
  }, [form.extraPrompt, pushToast]);

  const appendExtraPromptToNegative = useCallback(() => {
    const extra = form.extraPrompt.trim();
    if (!extra) {
      pushToast("warning", "请输入追加提示词");
      return;
    }
    setForm((prev) => {
      const { value } = appendPromptValue(prev.negativePrompt, extra);
      return {
        ...prev,
        negativePrompt: normalizePromptParams(value),
        extraPrompt: ""
      };
    });
    pushToast("success", "已添加至反向提示词");
  }, [form.extraPrompt, pushToast]);

  const restoreHistoryConfig = useCallback(async (id: string) => {
    const entry = history.find((candidate) => candidate.id === id);
    if (!entry) {
      pushToast("warning", "未找到这条生成历史");
      return;
    }
    if (settingsActions.settingsLoading) {
      pushToast("warning", "设置仍在加载，请稍后回填历史配置");
      return;
    }
    const generation = historyRestoreGenerationRef.current + 1;
    historyRestoreGenerationRef.current = generation;
    const restoredForm = hydrateHistoryForm(entry.params, entry.prompt);
    const restore = historyRestoreQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        if (generation !== historyRestoreGenerationRef.current) return;
        if (settingsRef.current.imageProvider !== entry.provider) {
          if (!settingsActions.updateSettings) {
            throw new Error("当前界面无法切换生成引擎，请先打开设置完成切换");
          }
          await settingsActions.updateSettings({ imageProvider: entry.provider });
          settingsRef.current = { ...settingsRef.current, imageProvider: entry.provider };
        }
        if (generation !== historyRestoreGenerationRef.current) return;
        setForm(restoredForm);
        pushToast("success", "已回填历史配置与生成引擎");
      });
    historyRestoreQueueRef.current = restore;
    try {
      await restore;
    } catch (caught) {
      if (generation !== historyRestoreGenerationRef.current) return;
      const message = caught instanceof Error ? caught.message : "历史配置回填失败";
      pushToast("error", `历史配置回填失败：${message}`);
    }
  }, [history, pushToast, settingsActions.settingsLoading, settingsActions.updateSettings]);

  const pasteHistoryResult = useCallback(async (id: string) => {
    const entry = history.find((candidate) => candidate.id === id);
    if (!entry) {
      pushToast("warning", "未找到这条生成历史");
      return;
    }
    try {
      if (!(await hasActiveSelection())) {
        pushToast("warning", "请先在 Photoshop 中选择一个区域");
        return;
      }
      const restored = hydrateHistoryForm(entry.params, entry.prompt);
      const info = await placeImageIntoSelection(entry.thumbnailDataUrl, 1, {
        feather: restored.maskFeather
      });
      const layerId = extractLayerId(info);
      if (layerId) await moveActiveLayerToTop({ layerId });
      pushToast("success", "历史结果已贴回当前选区");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "历史结果贴回失败";
      pushToast("error", message);
    }
  }, [history, pushToast]);

  const captureReferenceImage = useCallback(async () => {
    if (providerRef.current !== "gemini") {
      pushToast("warning", "参考图仅用于 Gemini 图像生成");
      return;
    }
    if (referenceCaptureLoadingRef.current) {
      pushToast("warning", "正在捕获参考图，请稍候");
      return;
    }
    if (referenceImagesRef.current.length >= REFERENCE_IMAGE_LIMIT) {
      pushToast("warning", `最多添加 ${REFERENCE_IMAGE_LIMIT} 张参考图`);
      return;
    }
    referenceCaptureLoadingRef.current = true;
    setReferenceCaptureLoading(true);
    const generation = referenceCaptureGenerationRef.current + 1;
    referenceCaptureGenerationRef.current = generation;
    try {
      const pixels = await getSelectionPixels({ maxEdge: REFERENCE_IMAGE_MAX_EDGE });
      if (generation !== referenceCaptureGenerationRef.current || providerRef.current !== "gemini") return;
      if (!pixels) {
        pushToast("warning", "请先在 Photoshop 中选择参考区域");
        return;
      }
      const next = appendReferenceImage(referenceImagesRef.current, pixels);
      commitReferenceImages(next);
      pushToast("success", `已添加参考图 ${next.length}`);
    } catch (caught) {
      if (generation !== referenceCaptureGenerationRef.current) return;
      const message = caught instanceof Error ? caught.message : "参考图捕获失败";
      pushToast("error", message);
    } finally {
      if (generation === referenceCaptureGenerationRef.current) {
        referenceCaptureLoadingRef.current = false;
        setReferenceCaptureLoading(false);
      }
    }
  }, [commitReferenceImages, pushToast]);

  const removeReferenceImage = useCallback((id: string) => {
    invalidateReferenceCapture();
    commitReferenceImages(discardReferenceImage(referenceImagesRef.current, id));
  }, [commitReferenceImages, invalidateReferenceCapture]);

  const moveReferenceImage = useCallback((id: string, direction: "left" | "right") => {
    invalidateReferenceCapture();
    commitReferenceImages(reorderReferenceImage(referenceImagesRef.current, id, direction));
  }, [commitReferenceImages, invalidateReferenceCapture]);

  const clearReferenceImages = useCallback(() => {
    invalidateReferenceCapture();
    commitReferenceImages([]);
  }, [commitReferenceImages, invalidateReferenceCapture]);

  const refreshOptions = useCallback(async () => {
    if (runGateRef.current.current) return;
    const requestToken = engineToken;
    const fetchOptions = requestToken.engine.fetchOptions;
    if (!fetchOptions) {
      commitIfCurrent(requestToken, () => {
        setOptions(EMPTY_OPTIONS);
        setOptionsError(null);
        setOptionsLoading(false);
      });
      return;
    }
    if (!settings.sdEndpoint) {
      commitIfCurrent(requestToken, () => {
        setOptions(EMPTY_OPTIONS);
        setOptionsError("请先在设置中配置算力地址");
        setOptionsLoading(false);
      });
      return;
    }
    commitIfCurrent(requestToken, () => {
      setOptionsLoading(true);
      setOptionsError(null);
    });
    try {
      const fetched = await fetchOptions();
      commitIfCurrent(requestToken, () => {
        setOptions(fetched);
        setForm((prev) => ({
          ...prev,
          sampler: prev.sampler || fetched.samplers[0]?.value || "",
          scheduler: prev.scheduler || fetched.schedulers[0]?.value || "",
          model: prev.model || fetched.models[0]?.value || "",
          vae: prev.vae || fetched.vaes[0]?.value || "",
          controlNetModel: prev.controlNetModel || fetched.controlNetModels[0]?.value || "",
          controlNetModule: prev.controlNetModule || fetched.controlNetModules[0]?.value || ""
        }));
      });
    } catch (err) {
      if (!isEngineCurrent(requestToken)) return;
      if (isGenerationCancelledError(err)) return;
      const message = err instanceof Error ? err.message : "选项获取失败";
      setOptionsError(message);
      pushToast("error", message);
    } finally {
      commitIfCurrent(requestToken, () => setOptionsLoading(false));
    }
  }, [commitIfCurrent, engineToken, isEngineCurrent, pushToast, settings.sdEndpoint]);

  useEffect(() => {
    refreshOptions().catch((err) => {
      console.error("Failed to refresh options on mount", err);
    });
  }, [refreshOptions]);

  useEffect(() => {
    loadPresets().catch((err) => {
      console.error("Failed to load presets", err);
    });
  }, [loadPresets]);

  const pollProgress = useCallback(() => {
    const activeRun = runGateRef.current.current;
    if (!activeRun) return;
    const runToken = activeRun.token;
    const isPollCurrent = () => runGateRef.current.isCurrent(runToken);
    startPolling(
      engineToken,
      (value) => {
        if (!isPollCurrent()) return;
        setProgress(value);
      },
      (info) => {
        if (!isPollCurrent()) return;
        setProgressPreview(info.current_image ? toDataUrl(info.current_image) : null);
        const text = info.textinfo || info.message;
        setProgressText(text ? String(text) : null);
      }
    );
  }, [engineToken, startPolling]);

  const stopGeneration = useCallback(() => {
    const activeRun = runGateRef.current.current;
    if (!activeRun) return;
    runGateRef.current.stop();
    invalidateGenerationRequest();
    engine.cancelAll();
    stopPolling(engineToken);
    if (activeRun.kind === "batch" && activeRun.taskId) {
      commitBatchItems((items) =>
        items.map((item) =>
          item.id === activeRun.taskId && item.status === "running"
            ? { ...item, status: "stopped", error: undefined }
            : item
        )
      );
    }
    setStatus("idle");
    setProgress(0);
    setProgressPreview(null);
    setProgressText(null);
    setError(null);
    pushToast("info", "已停止");
  }, [engine, engineToken, invalidateGenerationRequest, pushToast, stopPolling]);

  const runGeneration = useCallback(async () => {
    if (runGateRef.current.current) return;
    const requestToken = engineToken;
    const requestEngine = requestToken.engine;
    const session = beginGenerationRequest(requestEngine.provider);
    const taskId = generateId();
    const { token: runToken } = runGateRef.current.begin("single", taskId);
    const isRunCurrent = () =>
      isEngineCurrent(requestToken) &&
      runGateRef.current.isCurrent(runToken) &&
      isGenerationSessionCurrent(session);
    setStatus("running");
    setError(null);
    setProgress(0);
    setProgressPreview(null);
    setProgressText(null);
    dismissToast();
    try {
      const selection = await getSelectionPixels({ taskId });
      if (!isRunCurrent()) return;
      if (!selection && requestEngine.provider === "gemini") {
        throw new Error("请先在 Photoshop 中选择一个区域");
      }
      if (requestEngine.provider === "gemini") {
        session.retainReferenceImages(referenceImagesRef.current);
        setReferenceAspectWarning(getReferenceAspectWarning(selection, requireReferenceImages(session)));
      }
      const target = clampNumber(form.resolution, 128, 2048);
      const { width, height } = selection
        ? computeOverrideSize(selection.width, selection.height, target)
        : { width: target, height: target };
      let generatedDocument: GeneratedDocumentSession | null = null;
      const adapters = selection
        ? GENERATION_WORKFLOW_ADAPTERS
        : {
            ...GENERATION_WORKFLOW_ADAPTERS,
            placeImage: async (
              dataUrl: string,
              index: number,
              opts: { feather: number; taskId?: string }
            ) => {
              if (!generatedDocument) {
                generatedDocument = await createGeneratedDocument(width, height, undefined, {
                  taskId: opts.taskId
                });
              }
              return placeImageIntoDocument(dataUrl, index, generatedDocument.documentId, {
                taskId: opts.taskId
              });
            }
          };
      let result: GenerationWorkflowResult;
      try {
        result = await executeGenerationTask(
          requestEngine,
          {
            request: buildEngineGenerateParams(
              requestEngine.provider,
              settings,
              form,
              selection,
              width,
              height,
              taskId,
              requestEngine.provider === "gemini" ? requireReferenceImages(session) : [],
              session.controller.signal
            ),
            feather: Number.isFinite(form.maskFeather) ? form.maskFeather : DEFAULT_FORM.maskFeather,
            taskId,
            emptyImagesMessage: "未收到可用的生成图像",
            isCurrent: isRunCurrent,
            onRequestStart: () => {
              if (requestEngine.progressMode === "determinate") pollProgress();
            },
            onRequestSettled: () => stopPolling(requestToken)
          },
          adapters
        );
      } catch (workflowError) {
        if (generatedDocument) {
          await closeGeneratedDocument(
            (generatedDocument as GeneratedDocumentSession).documentId,
            (generatedDocument as GeneratedDocumentSession).previousDocumentId,
            { taskId }
          ).catch((cleanupError) =>
            ignoreBestEffortPhotoshopError("Failed to clean up generated document", cleanupError)
          );
        }
        throw workflowError;
      }
      if (!isRunCurrent()) return;
      const { images } = result;
      setProgress(1);
      setLastImages(images.map(toDataUrl));
      const historyRecord = await recordHistory({
        provider: settings.imageProvider,
        prompt: effectivePromptFor(form),
        params: { ...form },
        resultDataUrl: toDataUrl(images[0])
      });
      setStatus("success");
      if (historyRecord) pushToast("success", "生成成功");
    } catch (err) {
      stopPolling(requestToken);
      if (!isRunCurrent()) return;
      if (isGenerationCancelledError(err)) {
        runGateRef.current.complete(runToken);
        setStatus("idle");
        setProgress(0);
        setError(null);
        pushToast("info", "已停止");
        return;
      }
      const message = formatGenerationError(err, "生成失败");
      setStatus("error");
      setError(message);
      pushToast("error", message);
    } finally {
      stopPolling(requestToken);
      if (runGateRef.current.isCurrent(runToken)) {
        runGateRef.current.complete(runToken);
      }
      commitIfCurrent(requestToken, () => {
        setProgress(0);
        setProgressPreview(null);
        setProgressText(null);
      });
      finishGenerationRequest(session);
    }
  }, [beginGenerationRequest, commitIfCurrent, dismissToast, engineToken, finishGenerationRequest, form, isEngineCurrent, isGenerationSessionCurrent, pollProgress, pushToast, recordHistory, settings, stopPolling]);

  const addToBatch = useCallback(async () => {
    const taskId = generateId();
    const token = beginBatchAdd();
    try {
      const selection = await getSelectionPixels({ taskId });
      if (!isBatchAddCurrent(token)) return;
      if (!selection) {
        pushToast("warning", "没有检测到有效选区");
        return;
      }
      const target = clampNumber(form.resolution, 128, 2048);
      const { width, height } = computeOverrideSize(selection.width, selection.height, target);
      let docInfo: [number, number, number] | null = null;
      try {
        docInfo = await onBatchAddLayer({ taskId });
      } catch (error) {
        ignoreBestEffortPhotoshopError("onBatchAddLayer failed", error);
      }
      if (!isBatchAddCurrent(token)) {
        await cleanupStaleBatchResources(docInfo, taskId);
        return;
      }
      const taskReferences = token.provider === "gemini"
        ? referenceImagesRef.current.map((image) => ({ ...image }))
        : [];
      const taskAspectWarning = getReferenceAspectWarning(selection, taskReferences);
      setReferenceAspectWarning(taskAspectWarning);
      const item: BatchItem = {
        id: taskId,
        name: createBatchItemName(form, batchItemsRef.current.length),
        createdAt: new Date().toISOString(),
        form: { ...form },
        selection,
        overrideWidth: width,
        overrideHeight: height,
        status: "queued",
        referenceImages: taskReferences,
        referenceAspectWarning: taskAspectWarning ?? undefined,
        metadata: docInfo
          ? {
              activeDocumentId: docInfo[0],
              batchDocumentId: docInfo[1],
              newLayerId: docInfo[2]
            }
          : undefined
      };
      commitBatchItems((prev) => [...prev, item]);
      pushToast("success", `已加入批次：${item.name}`);
    } catch (error) {
      if (!isBatchAddCurrent(token)) return;
      const message = error instanceof Error ? error.message : "添加到批次失败";
      console.error(message, error);
      pushToast("error", message);
    }
  }, [beginBatchAdd, commitBatchItems, form, isBatchAddCurrent, pushToast]);

  const removeFromBatch = useCallback(
    async (id: string) => {
      const target = batchItemsRef.current.find((item) => item.id === id);
      engine.cancel(id);
      clearPSLockQueue(id);
      commitBatchItems((prev) => prev.filter((item) => item.id !== id));
      if (target?.metadata?.batchDocumentId && target.metadata.activeDocumentId && target.metadata.newLayerId) {
        await closeDocument(
          target.metadata.batchDocumentId,
          target.metadata.activeDocumentId,
          target.metadata.newLayerId,
          { taskId: id }
        );
      }
    },
    [commitBatchItems, engine]
  );

  const clearBatch = useCallback(async () => {
    invalidateBatchAdds();
    const items = batchItemsRef.current.map(({ id, metadata }) => ({ id, metadata: metadata ? { ...metadata } : undefined }));
    if (runGateRef.current.current?.kind === "batch") {
      stopGeneration();
    }
    commitBatchItems([]);
    for (const item of items) {
      engine.cancel(item.id);
      clearPSLockQueue(item.id);
      if (item.metadata?.batchDocumentId && item.metadata.activeDocumentId && item.metadata.newLayerId) {
        await closeDocument(
          item.metadata.batchDocumentId,
          item.metadata.activeDocumentId,
          item.metadata.newLayerId,
          { taskId: item.id }
        );
      }
    }
    pushToast("info", "批次已清空");
  }, [commitBatchItems, engine, invalidateBatchAdds, pushToast, stopGeneration]);

  const runBatch = useCallback(async () => {
    if (runGateRef.current.current) return;
    const runnableCount = batchItemsRef.current.filter((item) => item.status !== "success").length;
    if (!runnableCount) {
      if (batchItemsRef.current.length) {
        pushToast("info", "批次任务均已完成");
      } else {
        pushToast("warning", "批次列表为空");
      }
      return;
    }
    const requestToken = engineToken;
    const requestEngine = requestToken.engine;
    const session = beginGenerationRequest(requestEngine.provider);
    session.retainBatchItems(batchItemsRef.current.filter((item) => item.status !== "success"));
    const itemCount = session.batchItems?.length ?? 0;
    const { token: runToken } = runGateRef.current.begin("batch");
    const isRunCurrent = () =>
      isEngineCurrent(requestToken) &&
      runGateRef.current.isCurrent(runToken) &&
      isGenerationSessionCurrent(session);
    setStatus("running");
    setError(null);
    let historyRecorded = true;
    setProgress(0);
    commitBatchItems((items) =>
      items.map((item) =>
        item.status === "success" ? item : { ...item, status: "queued", error: undefined }
      )
    );
    let activeItemId: string | undefined;
    try {
      for (let itemIndex = 0; itemIndex < itemCount; itemIndex += 1) {
        if (!isRunCurrent()) return;
        activeItemId = requireBatchItem(session, itemIndex).id;
        runGateRef.current.setTask(runToken, activeItemId);
        commitBatchItems((items) =>
          items.map((candidate) =>
            candidate.id === activeItemId ? { ...candidate, status: "running", error: undefined } : candidate
          )
        );
        const feather =
          Number.isFinite(requireBatchItem(session, itemIndex).form.maskFeather) &&
          requireBatchItem(session, itemIndex).form.maskFeather >= 0
            ? requireBatchItem(session, itemIndex).form.maskFeather
            : DEFAULT_FORM.maskFeather;
        const taskId = activeItemId;
        const groupName = requireBatchItem(session, itemIndex).name;
        const result = await executeGenerationTask(
          requestEngine,
          {
            request: () => buildEngineGenerateParams(
              requestEngine.provider,
              settings,
              requireBatchItem(session, itemIndex).form,
              requireBatchItem(session, itemIndex).selection,
              requireBatchItem(session, itemIndex).overrideWidth,
              requireBatchItem(session, itemIndex).overrideHeight,
              taskId,
              requestEngine.provider === "gemini"
                ? requireBatchItem(session, itemIndex).referenceImages
                : [],
              session.controller.signal
            ),
            feather,
            taskId,
            groupName,
            emptyImagesMessage: `批次「${groupName}」未返回图像`,
            isCurrent: isRunCurrent,
            prepare: async () => {
              const activeDocumentId = requireBatchItem(session, itemIndex).metadata?.activeDocumentId;
              if (activeDocumentId) {
                await switchToDocument(activeDocumentId, { taskId }).catch((error) =>
                  ignoreBestEffortPhotoshopError("switchToDocument failed", error)
                );
                if (!isRunCurrent()) throw new StaleGenerationRequestError();
              }
              const selectionBounds = requireBatchItem(session, itemIndex).selection.selectionBounds;
              if (selectionBounds) {
                await setSelectionBounds(selectionBounds, { taskId }).catch((error) =>
                  ignoreBestEffortPhotoshopError("setSelectionBounds failed", error)
                );
              }
            },
            onRequestStart: () => {
              if (requestEngine.progressMode === "determinate") pollProgress();
            },
            onRequestSettled: () => stopPolling(requestToken)
          },
          GENERATION_WORKFLOW_ADAPTERS
        );
        if (!isRunCurrent()) return;
        commitBatchItems((items) =>
          items.map((candidate) =>
            candidate.id === taskId ? { ...candidate, status: "success", error: undefined } : candidate
          )
        );
        const completedForm = { ...requireBatchItem(session, itemIndex).form };
        const historyRecord = await recordHistory({
          provider: requestEngine.provider,
          prompt: effectivePromptFor(completedForm),
          params: completedForm,
          resultDataUrl: toDataUrl(result.images[0])
        });
        if (!historyRecord) historyRecorded = false;
        setProgress(0);
      }
      setStatus("success");
      if (historyRecorded) pushToast("success", "批次执行完成");
    } catch (caught) {
      stopPolling(requestToken);
      if (!isRunCurrent()) return;
      if (isGenerationCancelledError(caught)) {
        if (activeItemId) {
          commitBatchItems((items) =>
            items.map((item) =>
              item.id === activeItemId ? { ...item, status: "stopped", error: undefined } : item
            )
          );
        }
        runGateRef.current.complete(runToken);
        setStatus("idle");
        setProgress(0);
        setError(null);
        pushToast("info", "已停止");
        return;
      }
      const message = formatGenerationError(caught, "批次执行失败");
      if (activeItemId) {
        commitBatchItems((items) =>
          items.map((item) =>
            item.id === activeItemId ? { ...item, status: "error", error: message } : item
          )
        );
      }
      setStatus("error");
      setError(message);
      pushToast("error", message);
    } finally {
      stopPolling(requestToken);
      if (runGateRef.current.isCurrent(runToken)) {
        runGateRef.current.complete(runToken);
        setProgress(0);
        setProgressPreview(null);
        setProgressText(null);
      }
      finishGenerationRequest(session);
    }
  }, [beginGenerationRequest, commitBatchItems, engineToken, finishGenerationRequest, isEngineCurrent, isGenerationSessionCurrent, pollProgress, pushToast, recordHistory, settings, stopPolling]);

  const applyPreset = useCallback(
    async (fileName: string) => {
      const file = await loadPresetFile<PresetPayload>(fileName);
      if (!file?.data?.form) {
        throw new Error("预设文件格式不正确");
      }
      setForm((prev) => {
        const merged = {
          ...prev,
          ...DEFAULT_FORM,
          ...file.data.form
        } as GenerationForm & { presetShortcut?: unknown };
        delete merged.presetShortcut;
        return normalizeFormPrompts(merged);
      });
      setSelectedPreset(file.meta.name);
      pushToast("success", `已应用预设「${file.meta.name}」`);
    },
    [pushToast]
  );

  const savePreset = useCallback(
    async (name: string) => {
      presetsLoadGateRef.current.assertReady("预设仍在加载，请稍后重试");
      await savePresetFile<PresetPayload>(name, { form: normalizeFormPrompts(form) });
      setSelectedPreset(name);
      await loadPresets();
      pushToast("success", `预设「${name}」已保存`);
    },
    [form, loadPresets, pushToast]
  );

  const deletePreset = useCallback(
    async (fileName: string) => {
      presetsLoadGateRef.current.assertReady("预设仍在加载，请稍后重试");
      await deletePresetFile(fileName);
      await loadPresets();
      if (selectedPreset && fileName.startsWith(`${selectedPreset}`)) {
        setSelectedPreset(null);
      }
      pushToast("info", "预设已删除");
    },
    [loadPresets, selectedPreset, pushToast]
  );

  return {
    form,
    setFormValue,
    resetForm,
    setResolution,
    status,
    progress,
    progressMode: engine.progressMode,
    progressPreview,
    progressText,
    error,
    lastImages,
    options,
    optionsLoading,
    optionsError,
    refreshOptions,
    runGeneration,
    stopGeneration,
    referenceImages,
    referenceCaptureLoading,
    referenceAspectWarning,
    captureReferenceImage,
    removeReferenceImage,
    moveReferenceImage,
    clearReferenceImages,
    history,
    historyLoading,
    historyError,
    restoreHistoryConfig,
    pasteHistoryResult,
    batchItems,
    addToBatch,
    removeFromBatch,
    clearBatch,
    runBatch,
    toast,
    dismissToast,
    presets,
    selectedPreset,
    loadPresets,
    applyPreset,
    savePreset,
    deletePreset,
    setSelectedPreset,
    pushToast,
    translationInput,
    setTranslationInput,
    translationResult,
    translationError,
    translationLoading,
    sourceLanguage,
    targetLanguage,
    setSourceLanguage,
    setTargetLanguage,
    runTranslation,
    clearTranslation,
    appendTranslationToPositive,
    appendTranslationToNegative,
    appendExtraPromptToPositive,
    appendExtraPromptToNegative
  };
};
