import { useCallback, useEffect, useRef, useState } from "react";
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
  type EngineProgressMode,
  type GenerationEngine
} from "../services/generationEngine";
import { useGenerationEngine } from "./useGenerationEngine";
import { useEngineLifecycle } from "./useEngineLifecycle";
import {
  returnGenerationImages
} from "../services/generationWorkflow";
import {
  closeDocument,
  closeGeneratedDocument,
  createGeneratedDocument,
  deleteLayers,
  deleteTaskLayers,
  getActiveDocumentId,
  getSelectionPixels,
  groupLayers,
  hasActiveSelection,
  moveActiveLayerToTop,
  onBatchAddLayer,
  placeImageIntoDocument,
  placeImageIntoSelection,
  renameLayer,
  setSelectionBounds,
  switchToDocument,
  type GeneratedDocumentSession,
  type SelectionPixels
} from "../services/photoshop";
import {
  clearPSLockQueue,
  isPSLockControlError,
  PSCircuitOpenError
} from "../services/psLock";
import {
  deletePresetFile,
  listPresetMetas,
  loadPresetFile,
  savePresetFile,
  type PresetMeta
} from "../services/presets";
import { LatestLoadGate } from "../services/loadGate";
import { translateText } from "../services/translator";
import { useGenerationHistory } from "./useGenerationHistory";
import type { GenerationHistoryEntry } from "../services/generationHistory";
import { normalizePromptParams, sanitizePrompt } from "../services/promptParams";
import { useGenerationTaskPool } from "./useGenerationTaskPool";
import type { GenerationTaskSnapshot } from "../services/generationTaskPool";

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
  prepareReturn?: () => Promise<void>;
}

interface PresetPayload {
  form: GenerationForm;
}

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
const layerIdFrom = (value: unknown) => {
  if (!value || typeof value !== "object") return 0;
  const info = value as Record<string, unknown>;
  const layerId = Number(info.layerID ?? info.layerId ?? info.targetLayerID ?? info.targetLayerId ?? 0);
  return Number.isFinite(layerId) && layerId > 0 ? layerId : 0;
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
  taskId?: string
): EngineGenerateParams => {
  const prompt = sanitizePrompt(
    [form.positivePrompt, form.extraPrompt].filter(Boolean).join("\n").trim()
  );
  return {
    prompt,
    baseImageBase64: selection ? dataUrlToBase64(selection.dataUrl) : "",
    timeoutMs: Math.max(
      5_000,
      Math.round(settings.timeoutMaxSeconds * 1_000 * settings.timeoutMultiplier)
    ),
    taskId,
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
  const taskPool = useGenerationTaskPool(settings.maxConcurrentTasks);
  const {
    token: engineToken,
    isCurrent: isEngineCurrent,
    commitIfCurrent
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
  const presetsLoadGateRef = useRef(new LatestLoadGate());
  const settingsRef = useRef(settings);
  const historyRestoreGenerationRef = useRef(0);
  const historyRestoreQueueRef = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);
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
    taskStatus === "queued" || taskStatus === "running" || taskStatus === "returning"
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
      const placed = await placeImageIntoSelection(entry.thumbnailDataUrl, 1, {
        feather: restored.maskFeather
      });
      const layerId = layerIdFrom(placed);
      if (layerId) await moveActiveLayerToTop({ layerId });
      pushToast("success", "历史结果已贴回当前选区");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "历史结果贴回失败";
      pushToast("error", message);
    }
  }, [history, pushToast]);

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
        prepared.id
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
            let layersDeleted = false;
            const cleanup = async () => {
              if (returnTargetDocumentId) {
                await switchToDocument(returnTargetDocumentId, { taskId: prepared.id });
              }
              if (!layersDeleted) {
                if (groupLayerId && rollbackIds.length) {
                  await deleteLayers(rollbackIds, { taskId: prepared.id });
                } else {
                  await deleteTaskLayers(prepared.id, { taskId: prepared.id });
                }
                layersDeleted = true;
              }
              if (returnOriginDocumentId) {
                await switchToDocument(returnOriginDocumentId, { taskId: prepared.id });
              }
            };
            pendingCleanup = cleanup;
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
            pendingCleanup = cleanup;
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
      isDeferredReturnError: (caught) => caught instanceof PSCircuitOpenError,
      formatError: (caught) => formatGenerationError(caught, "生成任务失败")
    });
  }, [recordHistory, taskPool]);

  useEffect(() => {
    const activeTask = taskPool.tasks.find(({ status: taskStatus }) =>
      taskStatus === "queued" || taskStatus === "retrying" || taskStatus === "running" || taskStatus === "returning"
    );
    if (activeTask) {
      setStatus("running");
      setProgress(activeTask.progress);
      setProgressText(`${activeTask.title} · ${activeTask.countdown}s`);
      setError(null);
    } else {
      const latest = taskPool.tasks[0];
      setProgress(0);
      setProgressPreview(null);
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

    setBatchItems((items) => {
      let changed = false;
      const next = items.map((item) => {
        const task = taskPool.taskMap[item.id];
        if (!task) return item;
        const taskStatus: BatchItem["status"] =
          task.status === "cancelled"
            ? "stopped"
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
  }, [taskPool.taskMap, taskPool.tasks]);

  const stopGeneration = useCallback(() => {
    const activeTasks = taskPool.tasks.filter(({ status: taskStatus }) =>
      taskStatus === "queued" || taskStatus === "retrying" || taskStatus === "running" || taskStatus === "returning"
    );
    if (!activeTasks.length) return;
    for (const task of activeTasks) void taskPool.cancelTask(task.id);
    pushToast("info", `已停止 ${activeTasks.length} 个任务`);
  }, [pushToast, taskPool]);

  const runGeneration = useCallback(async () => {
    const taskId = generateId();
    setError(null);
    dismissToast();
    try {
      const selection = await getSelectionPixels({ taskId });
      if (!selection && engine.provider === "gemini") {
        throw new Error("请先在 Photoshop 中选择一个区域");
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
        height
      });
      if (completion.status === "success" && toastRef.current?.type !== "warning") {
        pushToast("success", "生成成功并已回传");
      }
      else if (completion.status === "awaiting-return") pushToast("warning", "生成完成，等待手动回传");
      else if (completion.status === "error") pushToast("error", completion.error ?? "生成失败");
    } catch (err) {
      const message = formatGenerationError(err, "生成失败");
      setError(message);
      pushToast("error", message);
    }
  }, [dismissToast, engine, enqueuePreparedTask, form, pushToast, settings, taskPool.tasks.length]);

  const addToBatch = useCallback(async () => {
    const taskId = generateId();
    try {
      const selection = await getSelectionPixels({ taskId });
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
      const item: BatchItem = {
        id: taskId,
        name: createBatchItemName(form, batchItems.length),
        createdAt: new Date().toISOString(),
        form: { ...form },
        selection,
        overrideWidth: width,
        overrideHeight: height,
        status: "queued",
        metadata: docInfo
          ? {
              activeDocumentId: docInfo[0],
              batchDocumentId: docInfo[1],
              newLayerId: docInfo[2]
            }
          : undefined
      };
      setBatchItems((prev) => [...prev, item]);
      pushToast("success", `已加入批次：${item.name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "添加到批次失败";
      console.error(message, error);
      pushToast("error", message);
    }
  }, [batchItems.length, form, pushToast]);

  const removeFromBatch = useCallback(
    async (id: string) => {
      const target = batchItems.find((item) => item.id === id);
      if (!(await taskPool.removeTask(id))) clearPSLockQueue(id);
      setBatchItems((prev) => prev.filter((item) => item.id !== id));
      if (target?.metadata?.batchDocumentId && target.metadata.activeDocumentId && target.metadata.newLayerId) {
        await closeDocument(
          target.metadata.batchDocumentId,
          target.metadata.activeDocumentId,
          target.metadata.newLayerId,
          { taskId: id }
        );
      }
    },
    [batchItems, taskPool]
  );

  const clearBatch = useCallback(async () => {
    const items = batchItems.slice();
    setBatchItems([]);
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
  }, [batchItems, pushToast, taskPool]);

  const runBatch = useCallback(async () => {
    const runnableItems = batchItems.filter((item) => item.status !== "success");
    if (!runnableItems.length) {
      if (batchItems.length) {
        pushToast("info", "批次任务均已完成");
      } else {
        pushToast("warning", "批次列表为空");
      }
      return;
    }
    setError(null);
    setBatchItems((items) =>
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
  }, [batchItems, engine, enqueuePreparedTask, pushToast, settings, taskPool]);

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
    appendExtraPromptToNegative,
    generationTasks: taskPool.tasks,
    taskConcurrency: taskPool.concurrency,
    cancelTask: taskPool.cancelTask,
    retryTask: taskPool.retryTask,
    cleanupTask: taskPool.cleanupTask,
    returnTask: taskPool.returnTask,
    removeTask: taskPool.removeTask,
    extendTask: taskPool.extendTask,
    setTaskAutoReturn: taskPool.setTaskAutoReturn
  };
};
