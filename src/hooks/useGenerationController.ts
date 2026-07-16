import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  createGenerationEngine,
  formatGenerationError,
  GenerationEngineError,
  type EngineGenerateParams,
  type EngineProgressMode,
  type GenerationEngine
} from "../services/generationEngine";
import { useGenerationEngine } from "./useGenerationEngine";
import { useEngineLifecycle } from "./useEngineLifecycle";
import {
  executeGenerationTask,
  returnGenerationImages
} from "../services/generationWorkflow";
import {
  closeDocument,
  closeGeneratedDocument,
  createGeneratedDocument,
  deleteLayers,
  deleteLayersInDocument,
  deleteTaskLayers,
  getActiveDocumentId,
  getDocumentPixels,
  getSelectionPixels,
  getSelectionMetadata,
  groupLayers,
  hasActiveSelection,
  moveActiveLayerToTop,
  onBatchAddLayer,
  placeImageIntoDocument,
  placeImageIntoDocumentBounds,
  placeImageIntoSelection,
  renameLayer,
  setSelectionBounds,
  switchToDocument,
  type GeneratedDocumentSession,
  type SelectionPixels
} from "../services/photoshop";
import {
  clearPSLockQueue,
  isPSBusyError,
  isPSLockControlError
} from "../services/psLock";
import {
  deletePresetFile,
  listPresetMetas,
  loadPresetFile,
  savePresetFile,
  type ForgePreset,
  type GeminiPreset,
  type PresetDefinition,
  type PresetMeta
} from "../services/presets";
import { LatestLoadGate } from "../services/loadGate";
import { GenerationRunGate } from "../services/generationRunGate";
import { translateText } from "../services/translator";
import { useGenerationHistory } from "./useGenerationHistory";
import type { GenerationHistoryEntry } from "../services/generationHistory";
import { normalizePromptParams, sanitizePrompt } from "../services/promptParams";
import { useGenerationTaskPool } from "./useGenerationTaskPool";
import type { GenerationTaskSnapshot } from "../services/generationTaskPool";
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
import {
  DEFAULT_CAMERA_VIEW,
  buildCameraViewPrompt,
  loadCameraView,
  saveCameraView,
  snapCameraView,
  type CameraViewState
} from "../services/cameraView";
import {
  buildTiledUpscalePlan,
  executeTiledUpscale,
  TiledUpscaleRollbackError,
  type TiledUpscaleConfig,
  type TiledUpscaleProgress
} from "../services/tiledUpscale";
import { featherTileDataUrl } from "../services/tileImage";
import {
  executePosterWorkflow,
  type PosterWizardDraft
} from "../services/posterWizard";

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
  status: "queued" | "running" | "awaiting-return" | "success" | "stopped" | "error";
  error?: string;
  referenceImages: ReferenceImage[];
  referenceAspectWarning?: string;
  metadata?: {
    activeDocumentId?: number;
    batchDocumentId?: number;
    newLayerId?: number;
  };
}

interface PreparedPoolTask {
  id: string;
  title: string;
  engine: GenerationEngine;
  settings: AppSettings;
  form: GenerationForm;
  selection: SelectionPixels | null;
  width: number;
  height: number;
  groupName?: string;
  referenceImages?: ReferenceImage[];
  prepareReturn?: () => Promise<void>;
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
    groupLayers(layerIds, groupName, { ...options, requireGroup: true }),
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

export const mapForgeDataToForm = (data: unknown): GenerationForm => {
  const restored = { ...DEFAULT_FORM };
  if (!data || typeof data !== "object" || Array.isArray(data)) return restored;
  const source = data as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_FORM) as Array<keyof GenerationForm>) {
    const candidate = source[key];
    const defaultValue = DEFAULT_FORM[key];
    if (typeof candidate !== typeof defaultValue) continue;
    if (typeof candidate === "number" && !Number.isFinite(candidate)) continue;
    (restored as unknown as Record<string, unknown>)[key] = candidate;
  }
  return restored;
};

const hydrateHistoryForm = (params: unknown, fallbackPrompt: string): GenerationForm => {
  const restored = mapForgeDataToForm(params);
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
  cameraView: CameraViewState;
  cameraViewLoading: boolean;
  setCameraView: (value: CameraViewState) => void;
  runCameraViewGeneration: () => Promise<void>;
  stopGeneration: () => void;
  referenceImages: ReferenceImage[];
  referenceCaptureLoading: boolean;
  referenceAspectWarning: string | null;
  captureReferenceImage: () => Promise<void>;
  removeReferenceImage: (id: string) => void;
  moveReferenceImage: (id: string, direction: "left" | "right") => void;
  clearReferenceImages: () => void;
  tiledUpscaleRunning: boolean;
  tiledUpscaleStopping: boolean;
  tiledUpscaleProgress: TiledUpscaleProgress | null;
  tiledUpscaleSourceSize: { width: number; height: number } | null;
  inspectTiledUpscaleSelection: () => Promise<boolean>;
  runTiledUpscale: (config: TiledUpscaleConfig) => Promise<boolean>;
  posterRunning: boolean;
  posterLastResult: PosterGenerationResult | null;
  runPosterWizard: (draft: PosterWizardDraft) => Promise<boolean>;
  undoPosterGeneration: () => Promise<void>;
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
  generationTasks: GenerationTaskSnapshot[];
  taskConcurrency: number;
  cancelTask: (id: string) => Promise<GenerationTaskSnapshot | null>;
  retryTask: (id: string) => Promise<GenerationTaskSnapshot | null>;
  cleanupTask: (id: string) => Promise<GenerationTaskSnapshot | null>;
  returnTask: (id: string) => Promise<GenerationTaskSnapshot | null>;
  removeTask: (id: string) => Promise<boolean>;
  extendTask: (id: string, seconds?: number) => boolean;
  setTaskAutoReturn: (id: string, autoReturn: boolean) => boolean;
  toast: ToastState | null;
  dismissToast: () => void;
  presets: PresetMeta[];
  selectedPreset: string | null;
  loadPresets: () => Promise<void>;
  applyPreset: (fileName: string) => Promise<void>;
  savePreset: (name: string, targetFileName?: string) => Promise<void>;
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

export interface PosterGenerationResult {
  taskId: string;
  documentId: number;
  placedLayerIds: number[];
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
  const taskPool = useGenerationTaskPool(settings.maxConcurrentTasks);
  const taskPoolRef = useRef(taskPool);
  taskPoolRef.current = taskPool;
  const cameraEngine = useMemo(
    () => createGenerationEngine({ ...settings, imageProvider: "gemini" }),
    [
      settings.geminiApiKey,
      settings.geminiAuthMode,
      settings.geminiEndpoint,
      settings.geminiModel,
      settings.offlineMode,
      settings.timeoutMaxSeconds,
      settings.timeoutMinSeconds,
      settings.timeoutMultiplier
    ]
  );
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
  const [runProgressMode, setRunProgressMode] = useState<EngineProgressMode | null>(null);
  const [progressPreview, setProgressPreview] = useState<string | null>(null);
  const [progressText, setProgressText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastImages, setLastImages] = useState<string[]>([]);
  const [tiledUpscaleRunning, setTiledUpscaleRunning] = useState(false);
  const [tiledUpscaleStopping, setTiledUpscaleStopping] = useState(false);
  const [tiledUpscaleProgress, setTiledUpscaleProgress] = useState<TiledUpscaleProgress | null>(null);
  const [tiledUpscaleSourceSize, setTiledUpscaleSourceSize] = useState<{ width: number; height: number } | null>(null);
  const [posterRunning, setPosterRunning] = useState(false);
  const [posterLastResult, setPosterLastResult] = useState<PosterGenerationResult | null>(null);
  const [options, setOptions] = useState<SdOptions>(EMPTY_OPTIONS);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [referenceImages, setReferenceImages] = useState<ReferenceImage[]>([]);
  const [referenceCaptureLoading, setReferenceCaptureLoading] = useState(false);
  const [referenceAspectWarning, setReferenceAspectWarning] = useState<string | null>(null);
  const [cameraView, setCameraViewState] = useState<CameraViewState>(DEFAULT_CAMERA_VIEW);
  const [cameraViewLoading, setCameraViewLoading] = useState(true);
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
  const toastRef = useRef<ToastState | null>(null);
  const tiledUpscaleSettlingRef = useRef(false);
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
  const presetApplyGenerationRef = useRef(0);
  const presetApplyQueueRef = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);
  const runGateRef = useRef(new GenerationRunGate());
  const activeRunEngineRef = useRef<GenerationEngine | null>(null);
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
    const tiledUpscaleSettling = tiledUpscaleSettlingRef.current;
    providerRef.current = settings.imageProvider;
    invalidateBatchAdds();
    invalidateGenerationRequest();
    for (const snapshot of taskPoolRef.current.tasks) {
      if (
        snapshot.engine === "gemini" &&
        (snapshot.status === "queued" ||
          snapshot.status === "retrying" ||
          snapshot.status === "running")
      ) {
        // Gemini 任务携带参考图等敏感内容，供应商切换后立即中止；
        // Forge 任务继续在其捕获的引擎上完成，避免浪费已消耗的算力。
        taskPoolRef.current.cancelTask(snapshot.id);
      }
    }
    setProgress(0);
    setRunProgressMode(null);
    setTiledUpscaleRunning(tiledUpscaleSettling);
    setTiledUpscaleStopping(tiledUpscaleSettling);
    setTiledUpscaleProgress(null);
    setPosterRunning(false);
    setStatus((current) => current === "running" && !tiledUpscaleSettling ? "idle" : current);
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
    batchAddGenerationRef.current += 1;
    invalidateGenerationRequest();
    referenceCaptureGenerationRef.current += 1;
    referenceCaptureLoadingRef.current = false;
    referenceImagesRef.current = [];
    batchItemsRef.current = [];
  }, [invalidateGenerationRequest]);


  useEffect(() => () => {
    if (runGateRef.current.stop()) {
      (activeRunEngineRef.current ?? engine).cancelAll();
      activeRunEngineRef.current = null;
      stoppedByEngineChangeRef.current = true;
    }
  }, [engine]);
  useEffect(() => () => {
    if (activeRunEngineRef.current !== cameraEngine) return;
    if (runGateRef.current.stop()) {
      cameraEngine.cancelAll();
      activeRunEngineRef.current = null;
      stoppedByEngineChangeRef.current = true;
    }
  }, [cameraEngine]);
  const clearToastTimer = useCallback(() => {
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
  }, []);
  const pushToast = useCallback((type: ToastType, message: string) => {
    const next = { type, message };
    toastRef.current = next;
    setToast(next);
  }, []);
  const {
    entries: history,
    loading: historyLoading,
    error: historyError,
    record: recordHistory
  } = useGenerationHistory<GenerationForm>((message) => pushToast("warning", message));
  const dismissToast = useCallback(() => {
    clearToastTimer();
    toastRef.current = null;
    setToast(null);
  }, [clearToastTimer]);
  useEffect(() => {
    if (!toast) {
      clearToastTimer();
      return;
    }
    clearToastTimer();
    toastTimerRef.current = setTimeout(() => {
      toastRef.current = null;
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
    setStatus((current) => current === "running" ? "idle" : current);
    setProgress(0);
    setRunProgressMode(null);
    setProgressPreview(null);
    setProgressText(null);
    setError(null);
    pushToast("info", "设置已更新，当前生成已停止");
  }, [cameraEngine, engine, pushToast]);

  useEffect(() => {
    let current = true;
    setCameraViewLoading(true);
    loadCameraView()
      .then((loaded) => {
        if (current) setCameraViewState(loaded);
      })
      .catch((caught) => {
        if (!current) return;
        const message = caught instanceof Error ? caught.message : "机位状态恢复失败";
        pushToast("warning", `机位状态恢复失败：${message}`);
      })
      .finally(() => {
        if (current) setCameraViewLoading(false);
      });
    return () => {
      current = false;
    };
  }, [pushToast]);

  const setCameraView = useCallback((value: CameraViewState) => {
    const next = snapCameraView(value);
    setCameraViewState(next);
    void saveCameraView(next).catch((caught) => {
      const message = caught instanceof Error ? caught.message : "机位状态保存失败";
      pushToast("warning", `机位状态保存失败：${message}`);
    });
  }, [pushToast]);

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

  const hasActiveGenerationTask = taskPool.tasks.some(({ status: taskStatus }) =>
    taskStatus === "queued" || taskStatus === "retrying" || taskStatus === "cancelling" ||
    taskStatus === "running" || taskStatus === "returning"
  );
  const hasActiveGenerationTaskRef = useRef(hasActiveGenerationTask);
  hasActiveGenerationTaskRef.current = hasActiveGenerationTask;

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
    if (hasActiveGenerationTaskRef.current) return;
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

  const enqueuePreparedTask = useCallback((prepared: PreparedPoolTask) => {
    let generatedDocument: GeneratedDocumentSession | null = null;
    let returnOriginDocumentId: number | null = null;
    let returnTargetDocumentId: number | null = null;
    let pendingCleanup: (() => Promise<void>) | null = null;
    let markCleanupPending: (() => void) | null = null;
    const registerCleanup = (cleanup: () => Promise<void>) => {
      pendingCleanup = cleanup;
      markCleanupPending?.();
    };
    const timeoutSeconds = Math.max(
      5,
      prepared.settings.timeoutMaxSeconds * prepared.settings.timeoutMultiplier
    );
    const request = {
      ...buildEngineGenerateParams(
        prepared.engine.provider,
        prepared.settings,
        prepared.form,
        prepared.selection,
        prepared.width,
        prepared.height,
        prepared.id,
        prepared.engine.provider === "gemini" ? prepared.referenceImages ?? [] : []
      ),
      // The pool owns the extendable deadline; the client timeout remains a final failsafe.
      timeoutMs: 24 * 60 * 60 * 1_000
    };
    const baseAdapters = {
      ...GENERATION_WORKFLOW_ADAPTERS,
      groupLayers: (
        layerIds: number[],
        _groupName: string | undefined,
        options: { taskId?: string }
      ) => groupLayers(layerIds, `PXD 临时任务 ${prepared.id}`, {
        ...options,
        requireGroup: true
      }),
      moveActiveLayerToTop: async (options: { layerId: number; taskId?: string }) => {
        await moveActiveLayerToTop(options);
        await renameLayer(options.layerId, prepared.groupName || "PXD 生成结果", {
          taskId: options.taskId
        });
      }
    };
    const adapters = prepared.selection
      ? {
          ...baseAdapters,
          rollback: async ({ placedLayerIds, groupLayerId }: {
            placedLayerIds: number[];
            groupLayerId: number | null;
          }) => {
            const rollbackIds = groupLayerId ? [groupLayerId] : placedLayerIds;
            let preciseLayersDeleted = rollbackIds.length === 0;
            let taskMarkersDeleted = false;
            const cleanup = async () => {
              if (returnTargetDocumentId) {
                await switchToDocument(returnTargetDocumentId, { taskId: prepared.id });
              }
              if (!preciseLayersDeleted) {
                await deleteLayers(rollbackIds, { taskId: prepared.id });
                preciseLayersDeleted = true;
              }
              if (!taskMarkersDeleted) {
                await deleteTaskLayers(prepared.id, { taskId: prepared.id });
                taskMarkersDeleted = true;
              }
              if (returnOriginDocumentId) {
                await switchToDocument(returnOriginDocumentId, { taskId: prepared.id });
              }
            };
            registerCleanup(cleanup);
            try {
              await cleanup();
              pendingCleanup = null;
            } catch (error) {
              throw error;
            }
          }
        }
      : {
          ...baseAdapters,
          placeImage: async (
            dataUrl: string,
            index: number,
            options: { feather: number; taskId?: string }
          ) => {
            if (!generatedDocument) {
              generatedDocument = await createGeneratedDocument(
                prepared.width,
                prepared.height,
                undefined,
                { taskId: options.taskId }
              );
            }
            return await placeImageIntoDocument(
              dataUrl,
              index,
              generatedDocument.documentId,
              { taskId: options.taskId }
            );
          },
          rollback: async () => {
            if (!generatedDocument) return;
            const session = generatedDocument;
            const cleanup = async () => {
              await closeGeneratedDocument(
                session.documentId,
                session.previousDocumentId,
                { taskId: prepared.id }
              );
              generatedDocument = null;
            };
            registerCleanup(cleanup);
            await cleanup();
            pendingCleanup = null;
          }
        };

    return taskPool.enqueueTask({
      id: prepared.id,
      title: prepared.title,
      engine: prepared.engine.provider,
      timeoutSeconds,
      run: async ({ signal, updateProgress }) => {
        updateProgress(0.02);
        const result = await prepared.engine.generate({ ...request, signal });
        updateProgress(1);
        return result.images;
      },
      returnImages: async (images, context) => {
        markCleanupPending = context.markCleanupPending;
        returnOriginDocumentId = await getActiveDocumentId({ taskId: prepared.id });
        returnTargetDocumentId = returnOriginDocumentId;
        await returnGenerationImages(
          prepared.engine,
          images,
          {
            feather: Number.isFinite(prepared.form.maskFeather)
              ? prepared.form.maskFeather
              : DEFAULT_FORM.maskFeather,
            taskId: prepared.id,
            groupName: prepared.groupName,
            prepare: async () => {
              await prepared.prepareReturn?.();
              returnTargetDocumentId = await getActiveDocumentId({ taskId: prepared.id });
            },
            isCurrent: context.isCurrent
          },
          adapters
        );
        generatedDocument = null;
        returnOriginDocumentId = null;
        returnTargetDocumentId = null;
        pendingCleanup = null;
        markCleanupPending = null;
      },
      cancelNetwork: () => {
        prepared.engine.cancel(prepared.id);
      },
      clearPendingReturn: () => {
        clearPSLockQueue(prepared.id);
      },
      cleanup: async () => {
        if (pendingCleanup) {
          const cleanup = pendingCleanup;
          await cleanup();
          if (pendingCleanup === cleanup) pendingCleanup = null;
        }
        if (!generatedDocument) return;
        const session = generatedDocument;
        await closeGeneratedDocument(
          session.documentId,
          session.previousDocumentId,
          { taskId: prepared.id }
        );
        generatedDocument = null;
      },
      onResult: async (images) => {
        setLastImages(images.map(toDataUrl));
        await recordHistory({
          provider: prepared.settings.imageProvider,
          prompt: effectivePromptFor(prepared.form),
          params: { ...prepared.form },
          resultDataUrl: toDataUrl(images[0])
        });
      },
      isCancelledError: isGenerationCancelledError,
      isDeferredReturnError: isPSBusyError,
      formatError: (caught) => formatGenerationError(caught, "生成任务失败")
    });
  }, [recordHistory, taskPool]);

  useEffect(() => {
    const activeTask = taskPool.tasks.find(({ status: taskStatus }) =>
      taskStatus === "queued" || taskStatus === "retrying" || taskStatus === "cancelling" ||
      taskStatus === "running" || taskStatus === "returning"
    );
    if (activeTask) {
      setStatus("running");
      // Real progress is driven by the Forge polling effect below; keep only the
      // countdown label here so we never surface a synthesized deadline ratio.
      if (!(activeTask.status === "running" && activeTask.engine === "forge")) {
        setProgress(0);
      }
      setProgressText(`${activeTask.title} · ${activeTask.countdown}s`);
      setError(null);
    } else {
      const latest = taskPool.tasks[0];
      setProgress(0);
      setProgressText(null);
      if (!latest || latest.status === "cancelled") {
        setStatus("idle");
        setError(null);
      } else if (latest.status === "error") {
        setStatus("error");
        setError(latest.error ?? "生成失败");
      } else {
        setStatus("success");
        setError(null);
      }
    }

    commitBatchItems((items) => {
      let changed = false;
      const next = items.map((item) => {
        const task = taskPool.taskMap[item.id];
        if (!task) return item;
        const taskStatus: BatchItem["status"] =
          task.status === "cancelled"
            ? "stopped"
            : task.status === "cancelling"
              ? "running"
            : task.status === "retrying"
              ? "queued"
            : task.status === "returning"
              ? "running"
              : task.status;
        const taskError = task.status === "error" || task.status === "awaiting-return"
          ? task.error
          : undefined;
        if (item.status === taskStatus && item.error === taskError) return item;
        changed = true;
        return { ...item, status: taskStatus, error: taskError };
      });
      return changed ? next : items;
    });
  }, [commitBatchItems, taskPool.taskMap, taskPool.tasks]);

  // Decision #3: drive real Forge progress + current_image preview whenever the pool
  // has at least one running forge task. Forge's /progress is global, so a single
  // poller is sufficient. Gemini tasks stay indeterminate with no preview.
  const forgePollingActiveRef = useRef(false);
  useEffect(() => {
    const hasRunningForge = taskPool.tasks.some(
      (task) => task.status === "running" && task.engine === "forge"
    );
    if (hasRunningForge && !forgePollingActiveRef.current) {
      forgePollingActiveRef.current = true;
      startPolling(
        engineToken,
        (value) => setProgress(value),
        (info) => {
          setProgressPreview(info.current_image ? toDataUrl(info.current_image) : null);
          const text = info.textinfo || info.message;
          if (text) setProgressText(String(text));
        }
      );
    } else if (!hasRunningForge && forgePollingActiveRef.current) {
      forgePollingActiveRef.current = false;
      stopPolling(engineToken);
      setProgressPreview(null);
    }
  }, [engineToken, startPolling, stopPolling, taskPool.tasks]);

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
    const activeTasks = taskPool.tasks.filter(({ status: taskStatus }) =>
      taskStatus === "queued" || taskStatus === "retrying" || taskStatus === "cancelling" ||
      taskStatus === "running" || taskStatus === "returning"
    );
    const activeRun = runGateRef.current.current;
    if (!activeTasks.length && !activeRun) return;
    for (const task of activeTasks) void taskPool.cancelTask(task.id);
    let tiledUpscaleStopping = false;
    if (activeRun) {
      tiledUpscaleStopping = activeRun.kind === "tiled-upscale";
      runGateRef.current.stop();
      invalidateGenerationRequest();
      (activeRunEngineRef.current ?? engine).cancelAll();
      activeRunEngineRef.current = null;
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
      setTiledUpscaleRunning(tiledUpscaleStopping);
      setTiledUpscaleStopping(tiledUpscaleStopping);
      setTiledUpscaleProgress(null);
      setPosterRunning(false);
      setRunProgressMode(null);
    }
    setStatus(tiledUpscaleStopping ? "running" : "idle");
    setProgress(0);
    setProgressPreview(null);
    setProgressText(null);
    setError(null);
    if (activeTasks.length) {
      pushToast("info", tiledUpscaleStopping
        ? `已停止 ${activeTasks.length} 个任务，正在恢复源文档`
        : `已停止 ${activeTasks.length} 个任务`);
    } else {
      pushToast("info", tiledUpscaleStopping ? "正在停止并恢复源文档" : "已停止");
    }
  }, [commitBatchItems, engine, engineToken, invalidateGenerationRequest, pushToast, stopPolling, taskPool]);

  const inspectTiledUpscaleSelection = useCallback(async () => {
    if (hasActiveGenerationTaskRef.current) {
      pushToast("warning", "有生成任务进行中，请等待任务队列完成后再试");
      return false;
    }
    if (runGateRef.current.current || tiledUpscaleSettlingRef.current) return false;
    const metadata = await getSelectionMetadata();
    if (!metadata) {
      setTiledUpscaleSourceSize(null);
      pushToast("warning", "请先在 Photoshop 中选择需要放大的区域");
      return false;
    }
    setTiledUpscaleSourceSize({ width: metadata.width, height: metadata.height });
    return true;
  }, [pushToast]);

  const runTiledUpscale = useCallback(async (config: TiledUpscaleConfig): Promise<boolean> => {
    if (hasActiveGenerationTaskRef.current) {
      pushToast("warning", "有生成任务进行中，请等待任务队列完成后再试");
      return false;
    }
    if (runGateRef.current.current || tiledUpscaleSettlingRef.current) return false;
    tiledUpscaleSettlingRef.current = true;
    const requestToken = engineToken;
    const requestEngine = requestToken.engine;
    const taskId = generateId();
    const { token: runToken } = runGateRef.current.begin("tiled-upscale", taskId);
    const isRunCurrent = () => isEngineCurrent(requestToken) && runGateRef.current.isCurrent(runToken);
    setTiledUpscaleRunning(true);
    setTiledUpscaleStopping(false);
    setTiledUpscaleProgress(null);
    setStatus("running");
    setError(null);
    dismissToast();
    try {
      const source = await getSelectionMetadata({ taskId });
      if (!isRunCurrent()) return false;
      if (!source) throw new Error("请先在 Photoshop 中选择需要放大的区域");
      setTiledUpscaleSourceSize({ width: source.width, height: source.height });
      const plan = buildTiledUpscalePlan(source.width, source.height, config);
      if (requestEngine.provider === "forge" && config.tileSize * config.scale > 2048) {
        throw new Error("Forge 单瓦片输出不能超过 2048 像素，请减小瓦片或倍率");
      }
      await executeTiledUpscale({
        engine: requestEngine,
        source: {
          documentId: source.documentId,
          bounds: source.selectionBounds,
          width: source.width,
          height: source.height
        },
        config,
        taskId,
        isCurrent: isRunCurrent,
        onProgress: (next) => {
          if (!isRunCurrent()) return;
          setTiledUpscaleProgress(next);
          setProgress(next.completed / next.total);
          setProgressText(`瓦片 ${Math.min(next.completed + 1, next.total)}/${next.total}`);
        },
        adapters: {
          readTile: (documentId, bounds, tileTaskId) =>
            getDocumentPixels(documentId, bounds, { taskId: tileTaskId }),
          enhanceTile: async (activeEngine, dataUrl, tile, activeConfig, tileTaskId) => {
            const outputWidth = tile.output.right - tile.output.left;
            const outputHeight = tile.output.bottom - tile.output.top;
            const alignForgeDimension = (value: number) =>
              Math.min(2048, Math.max(64, Math.round(value / 8) * 8));
            const prompt = sanitizePrompt([
              activeConfig.prompt || "Enhance fine texture and edge detail.",
              "Preserve the exact composition, geometry, colors, text, identity, and tile boundary content.",
              "Do not add, remove, crop, or move any object. Return only the enhanced image tile."
            ].join("\n"));
            const result = await activeEngine.generate({
              prompt,
              baseImageBase64: dataUrlToBase64(dataUrl),
              timeoutMs: Math.max(5_000, Math.round(settings.timeoutMaxSeconds * 1_000 * settings.timeoutMultiplier)),
              taskId: `${tileTaskId}-${tile.id}`,
              forgeParams: activeEngine.provider === "forge"
                ? {
                    ...buildImg2ImgParams(
                      { ...form, imageCount: 1 },
                      dataUrl,
                      alignForgeDimension(outputWidth),
                      alignForgeDimension(outputHeight)
                    ),
                    prompt
                  }
                : undefined
            });
            if (!result.images[0]) throw new Error(`瓦片 ${tile.id} 未返回增强结果`);
            return toDataUrl(result.images[0]);
          },
          featherTile: featherTileDataUrl,
          createOutput: (width, height, name, outputTaskId) =>
            createGeneratedDocument(width, height, name, { taskId: outputTaskId }),
          placeTile: (dataUrl, bounds, index, documentId, placeTaskId) =>
            placeImageIntoDocumentBounds(dataUrl, bounds, index, documentId, { taskId: placeTaskId }),
          finalize: async (layerIds, documentId, finalizeTaskId) => {
            await switchToDocument(documentId, { taskId: finalizeTaskId });
            const groupId = await groupLayers(layerIds, "PXD 分块放大", {
              taskId: finalizeTaskId,
              requireGroup: true
            });
            if (groupId) await moveActiveLayerToTop({ layerId: groupId, taskId: finalizeTaskId });
          },
          rollback: (session, rollbackTaskId) => closeGeneratedDocument(
            session.documentId,
            session.previousDocumentId,
            { taskId: rollbackTaskId }
          )
        }
      });
      if (!isRunCurrent()) return false;
      setStatus("success");
      setProgress(1);
      setProgressText(`${plan.tiles.length} 个瓦片已完成`);
      pushToast("success", `分块放大完成：${plan.outputWidth}×${plan.outputHeight}`);
      return true;
    } catch (caught) {
      if (caught instanceof TiledUpscaleRollbackError) {
        const message = formatGenerationError(caught, "分块放大恢复失败");
        setStatus("error");
        setError(message);
        pushToast("error", message);
        return false;
      }
      if (!isRunCurrent()) return false;
      if (isGenerationCancelledError(caught)) {
        setStatus("idle");
        setError(null);
        return false;
      }
      const message = formatGenerationError(caught, "分块放大失败");
      setStatus("error");
      setError(message);
      pushToast("error", message);
      return false;
    } finally {
      if (runGateRef.current.isCurrent(runToken)) runGateRef.current.complete(runToken);
      tiledUpscaleSettlingRef.current = false;
      setTiledUpscaleRunning(false);
      setTiledUpscaleStopping(false);
      setProgress(0);
      setStatus((current) => current === "running" ? "idle" : current);
    }
  }, [dismissToast, engineToken, form, isEngineCurrent, pushToast, settings.timeoutMaxSeconds, settings.timeoutMultiplier]);

  const runPosterWizard = useCallback(async (draft: PosterWizardDraft): Promise<boolean> => {
    if (hasActiveGenerationTaskRef.current) {
      pushToast("warning", "有生成任务进行中，请等待任务队列完成后再试");
      return false;
    }
    if (runGateRef.current.current) return false;
    const requestToken = engineToken;
    const requestEngine = requestToken.engine;
    if (requestEngine.provider !== "gemini") {
      const message = "海报排版向导仅支持 Gemini 图像引擎；建议：请先在设置中将图像引擎切换为 Gemini。";
      setError(message);
      pushToast("warning", message);
      return false;
    }
    const taskId = generateId();
    const { token: runToken } = runGateRef.current.begin("poster", taskId);
    const isRunCurrent = () => isEngineCurrent(requestToken) && runGateRef.current.isCurrent(runToken);
    setPosterRunning(true);
    setStatus("running");
    setError(null);
    setProgress(0);
    setProgressPreview(null);
    setProgressText(null);
    dismissToast();
    try {
      const selection = await getSelectionPixels({ taskId });
      if (!isRunCurrent()) return false;
      if (!selection) {
        throw new Error("请先在 Photoshop 中选择需要保留的主体区域");
      }
      if (!Number.isInteger(selection.documentId) || selection.documentId <= 0) {
        throw new Error("无法确定海报源 Photoshop 文档");
      }
      const placedLayerIds: number[] = [];
      const trackPlacedLayer = (layerId: number) => {
        if (!placedLayerIds.includes(layerId)) placedLayerIds.push(layerId);
        setPosterLastResult({
          taskId,
          documentId: selection.documentId,
          placedLayerIds: [...placedLayerIds]
        });
      };
      const posterAdapters = {
        ...GENERATION_WORKFLOW_ADAPTERS,
        placeImage: async (
          dataUrl: string,
          index: number,
          options: {
            feather: number;
            taskId?: string;
            onLayerPlaced?: (layerId: number) => void | Promise<void>;
          }
        ) => {
          await switchToDocument(selection.documentId, { taskId: options.taskId });
          return placeImageIntoSelection(dataUrl, index, options);
        }
      };
      const result = await executePosterWorkflow({
        engine: requestEngine,
        draft,
        baseImageBase64: dataUrlToBase64(selection.dataUrl),
        timeoutMs: Math.max(
          5_000,
          Math.round(settings.timeoutMaxSeconds * 1_000 * settings.timeoutMultiplier)
        ),
        feather: Number.isFinite(form.maskFeather) ? form.maskFeather : DEFAULT_FORM.maskFeather,
        taskId,
        adapters: posterAdapters,
        isCurrent: isRunCurrent,
        onRequestStart: () => {
          if (requestEngine.progressMode === "determinate") pollProgress();
        },
        onRequestSettled: () => stopPolling(requestToken),
        onLayerPlaced: trackPlacedLayer
      });
      if (!isRunCurrent()) return false;
      setLastImages(result.images.map(toDataUrl));
      setPosterLastResult({
        taskId,
        documentId: selection.documentId,
        placedLayerIds: result.placedLayerIds
      });
      setProgress(1);
      const historyRecord = await recordHistory({
        provider: "gemini",
        prompt: result.prompt.userPrompt,
        params: { ...form },
        resultDataUrl: toDataUrl(result.images[0])
      });
      if (!isRunCurrent()) return false;
      setStatus("success");
      if (historyRecord) pushToast("success", "海报已生成并贴入 Photoshop");
      return true;
    } catch (caught) {
      stopPolling(requestToken);
      if (!isRunCurrent()) return false;
      if (isGenerationCancelledError(caught)) {
        setStatus("idle");
        setError(null);
        pushToast("info", "已停止");
        return false;
      }
      const message = formatGenerationError(caught, "海报生成失败");
      setStatus("error");
      setError(message);
      pushToast("error", message);
      return false;
    } finally {
      stopPolling(requestToken);
      if (runGateRef.current.isCurrent(runToken)) {
        runGateRef.current.complete(runToken);
        setPosterRunning(false);
      }
      commitIfCurrent(requestToken, () => {
        setProgress(0);
        setProgressPreview(null);
        setProgressText(null);
      });
    }
  }, [commitIfCurrent, dismissToast, engineToken, form, isEngineCurrent, pollProgress, pushToast, recordHistory, settings.timeoutMaxSeconds, settings.timeoutMultiplier, stopPolling]);

  const undoPosterGeneration = useCallback(async () => {
    const result = posterLastResult;
    if (!result || posterRunning) return;
    try {
      await deleteLayersInDocument(result.documentId, result.placedLayerIds, { taskId: result.taskId });
      setPosterLastResult(null);
      pushToast("success", "已移除上一次海报生成图层");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "海报图层移除失败";
      pushToast("error", `撤销海报生成失败：${message}`);
    }
  }, [posterLastResult, posterRunning, pushToast]);

  const runCameraViewGeneration = useCallback(async () => {
    if (hasActiveGenerationTaskRef.current) {
      pushToast("warning", "有生成任务进行中，请等待任务队列完成后再试");
      return;
    }
    if (runGateRef.current.current || cameraViewLoading) return;
    const requestEngine = cameraEngine;
    const view = snapCameraView(cameraView);
    const prompt = buildCameraViewPrompt(view);
    const taskId = generateId();
    const { token: runToken } = runGateRef.current.begin("single", taskId);
    activeRunEngineRef.current = requestEngine;
    const isRunCurrent = () =>
      activeRunEngineRef.current === requestEngine && runGateRef.current.isCurrent(runToken);
    setStatus("running");
    setError(null);
    setProgress(0);
    setRunProgressMode("indeterminate");
    setProgressPreview(null);
    setProgressText("正在重设机位");
    dismissToast();
    try {
      const selection = await getSelectionPixels({ taskId });
      if (!isRunCurrent()) return;
      if (!selection) throw new Error("请先在 Photoshop 中选择一个主体区域");
      const result = await executeGenerationTask(
        requestEngine,
        {
          request: {
            prompt,
            baseImageBase64: dataUrlToBase64(selection.dataUrl),
            timeoutMs: Math.max(
              5_000,
              Math.round(settings.timeoutMaxSeconds * 1_000 * settings.timeoutMultiplier)
            ),
            taskId
          },
          feather: Number.isFinite(form.maskFeather) ? form.maskFeather : DEFAULT_FORM.maskFeather,
          taskId,
          emptyImagesMessage: "机位生成未返回可用图像",
          isCurrent: isRunCurrent
        },
        GENERATION_WORKFLOW_ADAPTERS
      );
      if (!isRunCurrent()) return;
      setProgress(1);
      setLastImages(result.images.map(toDataUrl));
      const historyForm = { ...form, positivePrompt: prompt, extraPrompt: "" };
      const historyRecord = await recordHistory({
        provider: "gemini",
        prompt,
        params: historyForm,
        resultDataUrl: toDataUrl(result.images[0])
      });
      if (!isRunCurrent()) return;
      setStatus("success");
      if (historyRecord) pushToast("success", "机位重设完成");
    } catch (caught) {
      if (!isRunCurrent()) return;
      if (isGenerationCancelledError(caught)) {
        runGateRef.current.complete(runToken);
        setStatus("idle");
        setProgress(0);
        setError(null);
        pushToast("info", "已停止");
        return;
      }
      const message = formatGenerationError(caught, "机位生成失败");
      setStatus("error");
      setError(message);
      pushToast("error", message);
    } finally {
      if (runGateRef.current.isCurrent(runToken)) runGateRef.current.complete(runToken);
      if (activeRunEngineRef.current === requestEngine) activeRunEngineRef.current = null;
      if (!runGateRef.current.current) {
        setProgress(0);
        setRunProgressMode(null);
        setProgressPreview(null);
        setProgressText(null);
      }
    }
  }, [cameraEngine, cameraView, cameraViewLoading, dismissToast, form, pushToast, recordHistory, settings.timeoutMaxSeconds, settings.timeoutMultiplier]);

  const runGeneration = useCallback(async () => {
    if (runGateRef.current.current || tiledUpscaleSettlingRef.current) {
      pushToast("warning", "海报/分块/机位任务进行中，请稍后再试");
      return;
    }
    const taskId = generateId();
    const session = beginGenerationRequest(engine.provider);
    setError(null);
    dismissToast();
    try {
      const selection = await getSelectionPixels({ taskId });
      if (!isGenerationSessionCurrent(session)) return;
      if (!selection && engine.provider === "gemini") {
        throw new Error("请先在 Photoshop 中选择一个区域");
      }
      const referenceImages = engine.provider === "gemini"
        ? referenceImagesRef.current.map((image) => ({ ...image }))
        : [];
      if (selection && engine.provider === "gemini") {
        setReferenceAspectWarning(getReferenceAspectWarning(selection, referenceImages));
      }
      const target = clampNumber(form.resolution, 128, 2048);
      const { width, height } = selection
        ? computeOverrideSize(selection.width, selection.height, target)
        : { width: target, height: target };
      const completion = await enqueuePreparedTask({
        id: taskId,
        title: createBatchItemName(form, taskPool.tasks.length),
        engine,
        settings: { ...settings },
        form: { ...form },
        selection,
        width,
        height,
        referenceImages
      });
      if (completion.status === "success" && toastRef.current?.type !== "warning") {
        pushToast("success", "生成成功并已回传");
      }
      else if (completion.status === "awaiting-return") pushToast("warning", "生成完成，等待手动回传");
      else if (completion.status === "error") pushToast("error", completion.error ?? "生成失败");
    } catch (err) {
      if (!isGenerationSessionCurrent(session)) return;
      const message = formatGenerationError(err, "生成失败");
      setError(message);
      pushToast("error", message);
    } finally {
      finishGenerationRequest(session);
    }
  }, [beginGenerationRequest, dismissToast, engine, enqueuePreparedTask, finishGenerationRequest, form, isGenerationSessionCurrent, pushToast, settings, taskPool.tasks.length]);

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
      const metadata = batchItemsRef.current.find((item) => item.id === id)?.metadata;
      if (!(await taskPool.removeTask(id))) clearPSLockQueue(id);
      commitBatchItems((prev) => prev.filter((item) => item.id !== id));
      if (metadata?.batchDocumentId && metadata.activeDocumentId && metadata.newLayerId) {
        await closeDocument(
          metadata.batchDocumentId,
          metadata.activeDocumentId,
          metadata.newLayerId,
          { taskId: id }
        );
      }
    },
    [commitBatchItems, taskPool]
  );

  const clearBatch = useCallback(async () => {
    invalidateBatchAdds();
    const items = batchItemsRef.current.map(({ id, metadata }) => ({ id, metadata: metadata ? { ...metadata } : undefined }));
    commitBatchItems([]);
    for (const item of items) {
      if (!(await taskPool.removeTask(item.id))) clearPSLockQueue(item.id);
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
  }, [commitBatchItems, invalidateBatchAdds, pushToast, taskPool]);

  const runBatch = useCallback(async () => {
    if (runGateRef.current.current || tiledUpscaleSettlingRef.current) {
      pushToast("warning", "海报/分块/机位任务进行中，请稍后再试");
      return;
    }
    const runnableItems = batchItemsRef.current.filter((item) => item.status !== "success");
    if (!runnableItems.length) {
      if (batchItemsRef.current.length) {
        pushToast("info", "批次任务均已完成");
      } else {
        pushToast("warning", "批次列表为空");
      }
      return;
    }
    setError(null);
    commitBatchItems((items) =>
      items.map((item) =>
        runnableItems.some(({ id }) => id === item.id)
          ? { ...item, status: "queued", error: undefined }
          : item
      )
    );
    try {
      const capturedEngine = engine;
      const capturedSettings = { ...settings };
      const completions = runnableItems.map((item) => {
        const existing = taskPool.taskMap[item.id];
        if (existing) return taskPool.retryTask(item.id);
        return enqueuePreparedTask({
          id: item.id,
          title: item.name,
          engine: capturedEngine,
          settings: capturedSettings,
          form: { ...item.form },
          selection: item.selection,
          width: item.overrideWidth,
          height: item.overrideHeight,
          groupName: item.name,
          referenceImages: capturedEngine.provider === "gemini"
            ? item.referenceImages.map((image) => ({ ...image }))
            : [],
          prepareReturn: async () => {
            if (item.metadata?.activeDocumentId) {
              await switchToDocument(item.metadata.activeDocumentId, { taskId: item.id }).catch((caught) =>
                ignoreBestEffortPhotoshopError("switchToDocument failed", caught)
              );
            }
            if (item.selection.selectionBounds) {
              await setSelectionBounds(item.selection.selectionBounds, { taskId: item.id }).catch((caught) =>
                ignoreBestEffortPhotoshopError("setSelectionBounds failed", caught)
              );
            }
          }
        });
      });
      const completed = await Promise.all(completions);
      const successes = completed.filter((task) => task?.status === "success").length;
      const deferred = completed.filter((task) => task?.status === "awaiting-return").length;
      if (deferred) pushToast("warning", `${successes} 个任务已回传，${deferred} 个等待手动回传`);
      else if (toastRef.current?.type !== "warning") pushToast("success", `${successes} 个批次任务执行完成`);
    } catch (caught) {
      const message = formatGenerationError(caught, "批次执行失败");
      setError(message);
      pushToast("error", message);
    }
  }, [commitBatchItems, engine, enqueuePreparedTask, pushToast, settings, taskPool]);

  const applyPreset = useCallback(
    async (fileName: string) => {
      const generation = presetApplyGenerationRef.current + 1;
      presetApplyGenerationRef.current = generation;
      let file;
      try {
        file = await loadPresetFile<Partial<GenerationForm>>(fileName);
      } catch (caught) {
        if (generation !== presetApplyGenerationRef.current) return;
        throw caught;
      }
      if (generation !== presetApplyGenerationRef.current) return;
      if (!file) {
        throw new Error("预设文件格式不正确");
      }
      const apply = presetApplyQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          if (generation !== presetApplyGenerationRef.current) return;
          const targetProvider = file.preset.kind;
          if (settingsRef.current.imageProvider !== targetProvider) {
            if (settingsActions.settingsLoading) throw new Error("设置仍在加载，请稍后应用预设");
            if (!settingsActions.updateSettings) throw new Error(`当前界面无法切换到 ${targetProvider === "gemini" ? "Gemini" : "Forge"} 引擎`);
            await settingsActions.updateSettings({ imageProvider: targetProvider });
            settingsRef.current = { ...settingsRef.current, imageProvider: targetProvider };
          }
          if (generation !== presetApplyGenerationRef.current) return;
          if (file.preset.kind === "gemini") {
            const content = normalizePromptParams(file.preset.content);
            setForm((current) => ({
              ...current,
              positivePrompt: content,
              extraPrompt: ""
            }));
          } else {
            setForm(normalizeFormPrompts(mapForgeDataToForm(file.preset.data)));
          }
          setSelectedPreset(file.meta.fileName);
          pushToast("success", `已应用预设「${file.meta.name}」`);
        });
      presetApplyQueueRef.current = apply.then(
        () => undefined,
        () => undefined
      );
      try {
        await apply;
      } catch (caught) {
        if (generation !== presetApplyGenerationRef.current) return;
        throw caught;
      }
    },
    [pushToast, settingsActions.settingsLoading, settingsActions.updateSettings]
  );

  const savePreset = useCallback(
    async (name: string, targetFileName?: string) => {
      presetsLoadGateRef.current.assertReady("预设仍在加载，请稍后重试");
      const sourceMeta = presets.find((preset) => preset.fileName === selectedPreset);
      const targetMeta = targetFileName
        ? presets.find((preset) => preset.fileName === targetFileName)
        : null;
      if (targetFileName && (targetMeta?.isFactory || targetFileName.toLowerCase().startsWith("factory:"))) {
        throw new Error("出厂预设为只读，不能覆盖");
      }
      const normalizedForm = normalizeFormPrompts(form);
      const shared = {
        title: name,
        category: sourceMeta?.category ?? "用户预设",
        subCategory: sourceMeta?.subCategory
      };
      const preset: PresetDefinition<GenerationForm> = settingsRef.current.imageProvider === "gemini"
        ? {
            ...shared,
            kind: "gemini",
            content: [normalizedForm.positivePrompt, normalizedForm.extraPrompt].filter(Boolean).join("\n").trim()
          } satisfies GeminiPreset
        : {
            ...shared,
            kind: "forge",
            data: normalizedForm
          } satisfies ForgePreset<GenerationForm>;
      const saved = targetFileName
        ? await savePresetFile(name, preset, { targetFileName })
        : await savePresetFile(name, preset);
      setSelectedPreset(saved.meta.fileName);
      await loadPresets();
      pushToast("success", `预设「${name}」已保存`);
    },
    [form, loadPresets, presets, pushToast, selectedPreset]
  );

  const deletePreset = useCallback(
    async (fileName: string) => {
      presetsLoadGateRef.current.assertReady("预设仍在加载，请稍后重试");
      const target = presets.find((preset) => preset.fileName === fileName);
      if (target?.isFactory) throw new Error("出厂预设为只读，不能删除");
      await deletePresetFile(fileName);
      await loadPresets();
      if (selectedPreset === fileName) {
        setSelectedPreset(null);
      }
      pushToast("info", "预设已删除");
    },
    [loadPresets, presets, selectedPreset, pushToast]
  );

  return {
    form,
    setFormValue,
    resetForm,
    setResolution,
    status,
    progress,
    progressMode: runProgressMode ?? engine.progressMode,
    progressPreview,
    progressText,
    error,
    lastImages,
    options,
    optionsLoading,
    optionsError,
    refreshOptions,
    runGeneration,
    cameraView,
    cameraViewLoading,
    setCameraView,
    runCameraViewGeneration,
    stopGeneration,
    referenceImages,
    referenceCaptureLoading,
    referenceAspectWarning,
    captureReferenceImage,
    removeReferenceImage,
    moveReferenceImage,
    clearReferenceImages,
    tiledUpscaleRunning,
    tiledUpscaleStopping,
    tiledUpscaleProgress,
    tiledUpscaleSourceSize,
    inspectTiledUpscaleSelection,
    runTiledUpscale,
    posterRunning,
    posterLastResult,
    runPosterWizard,
    undoPosterGeneration,
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
    generationTasks: taskPool.tasks,
    taskConcurrency: taskPool.concurrency,
    cancelTask: taskPool.cancelTask,
    retryTask: taskPool.retryTask,
    cleanupTask: taskPool.cleanupTask,
    returnTask: taskPool.returnTask,
    removeTask: taskPool.removeTask,
    extendTask: taskPool.extendTask,
    setTaskAutoReturn: taskPool.setTaskAutoReturn,
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
