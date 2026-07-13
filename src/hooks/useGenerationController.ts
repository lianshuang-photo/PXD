import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppSettings } from "../context/types";
import {
  createPxdClient,
  isPxdRequestCancelledError,
  type ControlNetPayload,
  type Img2ImgParams,
  type SdOptions
} from "../services/apiClient";
import {
  createImageModelClient,
  ImageModelError,
  isImageModelCancelledError
} from "../services/imageModelClient";
import {
  closeDocument,
  getSelectionPixels,
  groupLayers,
  moveActiveLayerToTop,
  onBatchAddLayer,
  placeImageIntoSelection,
  setSelectionBounds,
  switchToDocument,
  type SelectionPixels
} from "../services/photoshop";
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
  presetShortcut: string;
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
  metadata?: {
    activeDocumentId?: number;
    batchDocumentId?: number;
    newLayerId?: number;
  };
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

const extractLayerId = (info: any): number | null => {
  const candidate =
    info?.layerID ??
    info?.layerId ??
    info?.targetLayerID ??
    info?.targetLayerId ??
    info?.ID ??
    info?.id ??
    0;
  const numeric = Number(candidate);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
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
  tiling: false,
  presetShortcut: ""
};

const toDataUrl = (base64: string) => `data:image/png;base64,${base64}`;
const toBase64 = (dataUrl: string) => dataUrl.includes(",") ? dataUrl.split(",").pop() ?? dataUrl : dataUrl;

const formatGenerationError = (error: unknown, fallback: string) => {
  if (error instanceof ImageModelError) {
    return `${error.message}；建议：${error.solution}`;
  }
  return error instanceof Error ? error.message : fallback;
};

const isGenerationCancelledError = (error: unknown) =>
  isPxdRequestCancelledError(error) || isImageModelCancelledError(error);

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

const buildImg2ImgParams = (
  form: GenerationForm,
  baseImage: string,
  width: number,
  height: number
): Img2ImgParams => {
  const effectivePrompt = [form.positivePrompt, form.extraPrompt].filter(Boolean).join("\n").trim();
  return {
    prompt: effectivePrompt || form.positivePrompt,
    negativePrompt: form.negativePrompt,
    steps: clampNumber(form.steps, 1, 150),
    cfgScale: clampNumber(form.cfgScale, 1, 30),
    sampler: form.sampler || undefined,
    scheduler: form.scheduler || undefined,
    model: form.model || undefined,
    vae: form.vae || undefined,
    loras: form.lora ? [{ name: form.lora, weight: form.loraWeight || 1 }] : undefined,
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

export interface GenerationControllerState {
  form: GenerationForm;
  setFormValue: <K extends keyof GenerationForm>(key: K, value: GenerationForm[K]) => void;
  resetForm: () => void;
  setResolution: (value: number) => void;
  setPresetShortcut: (value: string) => void;
  status: GenerationStatus;
  progress: number;
  error: string | null;
  lastImages: string[];
  options: SdOptions;
  optionsLoading: boolean;
  optionsError: string | null;
  refreshOptions: () => Promise<void>;
  runGeneration: () => Promise<void>;
  stopGeneration: () => void;
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

export const useGenerationController = (settings: AppSettings): GenerationControllerState => {
  const client = useMemo(() => createPxdClient(settings), [settings]);
  const imageModelClient = useMemo(() => createImageModelClient(settings), [settings]);
  const [form, setForm] = useState<GenerationForm>(DEFAULT_FORM);
  const [status, setStatus] = useState<GenerationStatus>("idle");
  const [progress, setProgress] = useState(0);
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
  const pollingRef = useRef<number | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const presetsLoadGateRef = useRef(new LatestLoadGate());
  const optionsLoadGateRef = useRef(new LatestLoadGate());
  const runGateRef = useRef(new GenerationRunGate());
  const mountedRef = useRef(true);
  const stoppedForClientChangeRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const clearToastTimer = useCallback(() => {
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
  }, []);
  const pushToast = useCallback((type: ToastType, message: string) => {
    setToast({ type, message });
  }, []);
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

  const setFormValue = useCallback(
    <K extends keyof GenerationForm>(key: K, value: GenerationForm[K]) => {
      setForm((prev) => ({
        ...prev,
        [key]: value
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

  const setPresetShortcut = useCallback(
    (value: string) => {
      setFormValue("presetShortcut", value);
    },
    [setFormValue]
  );

  const setTranslationInput = useCallback((value: string) => {
    setTranslationError(null);
    setTranslationInputState(value);
  }, []);

  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      window.clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  const isCurrentRun = useCallback((token: number) => runGateRef.current.isCurrent(token), []);

  const stopGeneration = useCallback(() => {
    const activeRun = runGateRef.current.current;
    if (!activeRun) return;

    runGateRef.current.stop();
    client.cancelAll();
    imageModelClient.cancelAll();
    stopPolling();
    if (activeRun.kind === "batch" && activeRun.taskId) {
      setBatchItems((items) => items.map((item) =>
        item.id === activeRun.taskId && item.status === "running"
          ? { ...item, status: "stopped", error: undefined }
          : item
      ));
    }
    setStatus("idle");
    setProgress(0);
    setError(null);
    pushToast("info", "已停止");
  }, [client, imageModelClient, pushToast, stopPolling]);

  const loadPresets = useCallback(async () => {
    const gate = presetsLoadGateRef.current;
    const generation = gate.begin();
    try {
      const list = await listPresetMetas();
      if (mountedRef.current && gate.isCurrent(generation)) {
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
        positivePrompt: value
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
        negativePrompt: value
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
        positivePrompt: value,
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
        negativePrompt: value,
        extraPrompt: ""
      };
    });
    pushToast("success", "已添加至反向提示词");
  }, [form.extraPrompt, pushToast]);

  const refreshOptions = useCallback(async () => {
    if (runGateRef.current.current) return;
    const gate = optionsLoadGateRef.current;
    const generation = gate.begin();
    if (settings.imageProvider === "gemini") {
      setOptions(EMPTY_OPTIONS);
      setOptionsError(null);
      setOptionsLoading(false);
      gate.complete(generation);
      return;
    }
    if (!settings.sdEndpoint) {
      setOptions(EMPTY_OPTIONS);
      setOptionsError("请先在设置中配置算力地址");
      gate.complete(generation);
      return;
    }
    setOptionsLoading(true);
    setOptionsError(null);
    try {
      const fetched = await client.fetchOptions();
      if (!mountedRef.current || !gate.isCurrent(generation)) return;
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
    } catch (err) {
      if (!mountedRef.current || !gate.isCurrent(generation)) return;
      if (isPxdRequestCancelledError(err)) return;
      const message = err instanceof Error ? err.message : "选项获取失败";
      setOptionsError(message);
      pushToast("error", message);
    } finally {
      if (mountedRef.current && gate.isCurrent(generation)) {
        setOptionsLoading(false);
      }
      gate.complete(generation);
    }
  }, [client, settings.imageProvider, settings.sdEndpoint]);

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

  useEffect(() => () => {
    stoppedForClientChangeRef.current = Boolean(runGateRef.current.stop());
    client.cancelAll();
    imageModelClient.cancelAll();
    stopPolling();
  }, [client, imageModelClient, stopPolling]);

  useEffect(() => {
    if (!stoppedForClientChangeRef.current) return;
    stoppedForClientChangeRef.current = false;
    setBatchItems((items) => items.map((item) =>
      item.status === "running" ? { ...item, status: "stopped", error: undefined } : item
    ));
    setStatus("idle");
    setProgress(0);
    setError(null);
    pushToast("info", "设置已更新，当前生成已停止");
  }, [client, imageModelClient, pushToast]);

  const pollProgress = useCallback((runToken: number) => {
    stopPolling();
    pollingRef.current = window.setInterval(async () => {
      if (!isCurrentRun(runToken)) return;
      const progressInfo = await client.fetchProgress();
      if (isCurrentRun(runToken) && progressInfo && typeof progressInfo.progress === "number") {
        setProgress(progressInfo.progress);
      }
    }, 1_000);
  }, [client, isCurrentRun, stopPolling]);

  const runGeneration = useCallback(async () => {
    if (runGateRef.current.current) return;
    const taskId = generateId();
    const { token: runToken } = runGateRef.current.begin("single", taskId);
    setStatus("running");
    setError(null);
    setProgress(0);
    dismissToast();
    try {
      const selection = await getSelectionPixels();
      if (!isCurrentRun(runToken)) return;
      if (!selection) {
        throw new Error("请先在 Photoshop 中选择一个区域");
      }
      const target = clampNumber(form.resolution, 128, 2048);
      const { width, height } = computeOverrideSize(selection.width, selection.height, target);
      let images: string[];
      if (settings.imageProvider === "gemini") {
        const prompt = [form.positivePrompt, form.extraPrompt].filter(Boolean).join("\n").trim();
        const timeoutMs = Math.max(
          5_000,
          Math.round(settings.timeoutMaxSeconds * 1_000 * settings.timeoutMultiplier)
        );
        const image = await imageModelClient.editImage({
          prompt,
          baseImageBase64: toBase64(selection.dataUrl),
          aspectRatio: "Auto",
          timeoutMs,
          taskId
        });
        images = [image];
      } else {
        const params = buildImg2ImgParams(form, selection.dataUrl, width, height);
        pollProgress(runToken);
        const result = await client.img2img(params, { taskId });
        stopPolling();
        images = result.images ?? [];
      }
      if (!isCurrentRun(runToken)) return;
      setProgress(1);
      if (!images.length) {
        throw new Error("未收到可用的生成图像");
      }
      const placedLayerIds: number[] = [];
      const feather = Number.isFinite(form.maskFeather) ? form.maskFeather : DEFAULT_FORM.maskFeather;
      for (let i = 0; i < images.length; i++) {
        if (!isCurrentRun(runToken)) return;
        const info = await placeImageIntoSelection(toDataUrl(images[i]), i + 1, {
          feather
        });
        if (!isCurrentRun(runToken)) return;
        const id = extractLayerId(info);
        if (id) {
          placedLayerIds.push(id);
        }
      }
      if (placedLayerIds.length > 1) {
        await groupLayers(placedLayerIds).catch((error) => console.warn("groupLayers failed", error));
        if (!isCurrentRun(runToken)) return;
      }
      await moveActiveLayerToTop();
      if (!isCurrentRun(runToken)) return;
      setLastImages(images.map(toDataUrl));
      setStatus("success");
      pushToast("success", "生成成功");
    } catch (err) {
      stopPolling();
      if (!isCurrentRun(runToken)) return;
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
      stopPolling();
      if (isCurrentRun(runToken)) {
        runGateRef.current.complete(runToken);
        setProgress(0);
      }
    }
  }, [client, dismissToast, form, imageModelClient, isCurrentRun, pollProgress, pushToast, settings, stopPolling]);

  const addToBatch = useCallback(async () => {
    try {
      const selection = await getSelectionPixels();
      if (!selection) {
        pushToast("warning", "没有检测到有效选区");
        return;
      }
      const target = clampNumber(form.resolution, 128, 2048);
      const { width, height } = computeOverrideSize(selection.width, selection.height, target);
      let docInfo: [number, number, number] | null = null;
      try {
        docInfo = await onBatchAddLayer();
      } catch (error) {
        console.warn("onBatchAddLayer failed", error);
      }
      const item: BatchItem = {
        id: generateId(),
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
      client.cancel(id);
      imageModelClient.cancel(id);
      setBatchItems((prev) => {
        const target = prev.find((item) => item.id === id);
        if (target?.metadata?.batchDocumentId && target.metadata.activeDocumentId && target.metadata.newLayerId) {
          closeDocument(target.metadata.batchDocumentId, target.metadata.activeDocumentId, target.metadata.newLayerId).catch(
            (error) => console.warn("closeDocument failed", error)
          );
        }
        return prev.filter((item) => item.id !== id);
      });
    },
    [client, imageModelClient]
  );

  const clearBatch = useCallback(async () => {
    const items = batchItems.slice();
    if (runGateRef.current.current?.kind === "batch") {
      stopGeneration();
    }
    for (const item of items) {
      client.cancel(item.id);
      imageModelClient.cancel(item.id);
    }
    setBatchItems([]);
    for (const item of items) {
      if (item.metadata?.batchDocumentId && item.metadata.activeDocumentId && item.metadata.newLayerId) {
        await closeDocument(item.metadata.batchDocumentId, item.metadata.activeDocumentId, item.metadata.newLayerId).catch(
          (error) => console.warn("closeDocument failed", error)
        );
      }
    }
    pushToast("info", "批次已清空");
  }, [batchItems, client, imageModelClient, pushToast, stopGeneration]);

  const runBatch = useCallback(async () => {
    if (runGateRef.current.current) return;
    const runnableItems = batchItems.filter((item) => item.status !== "success");
    if (!runnableItems.length) {
      pushToast("info", batchItems.length ? "批次任务均已完成" : "批次列表为空");
      return;
    }
    const { token: runToken } = runGateRef.current.begin("batch");
    setStatus("running");
    setError(null);
    setProgress(0);
    setBatchItems((items) => items.map((item) =>
      item.status === "success" ? item : { ...item, status: "queued", error: undefined }
    ));
    let activeItemId: string | undefined;
    try {
      for (const item of runnableItems) {
        if (!isCurrentRun(runToken)) return;
        activeItemId = item.id;
        runGateRef.current.setTask(runToken, item.id);
        setBatchItems((items) => items.map((candidate) =>
          candidate.id === item.id ? { ...candidate, status: "running", error: undefined } : candidate
        ));
        if (item.metadata?.activeDocumentId) {
          await switchToDocument(item.metadata.activeDocumentId).catch((error) =>
            console.warn("switchToDocument failed", error)
          );
          if (!isCurrentRun(runToken)) return;
        }
        if (item.selection.selectionBounds) {
          await setSelectionBounds(item.selection.selectionBounds).catch((error) =>
            console.warn("setSelectionBounds failed", error)
          );
          if (!isCurrentRun(runToken)) return;
        }
        let images: string[];
        if (settings.imageProvider === "gemini") {
          const prompt = [item.form.positivePrompt, item.form.extraPrompt].filter(Boolean).join("\n").trim();
          const timeoutMs = Math.max(
            5_000,
            Math.round(settings.timeoutMaxSeconds * 1_000 * settings.timeoutMultiplier)
          );
          const image = await imageModelClient.editImage({
            prompt,
            baseImageBase64: toBase64(item.selection.dataUrl),
            aspectRatio: "Auto",
            timeoutMs,
            taskId: item.id
          });
          images = [image];
        } else {
          const params = buildImg2ImgParams(item.form, item.selection.dataUrl, item.overrideWidth, item.overrideHeight);
          pollProgress(runToken);
          const result = await client.img2img(params, { taskId: item.id });
          stopPolling();
          images = result.images ?? [];
        }
        if (!isCurrentRun(runToken)) return;
        if (!images.length) {
          throw new Error(`批次「${item.name}」未返回图像`);
        }
        const placedLayerIds: number[] = [];
        const feather =
          Number.isFinite(item.form?.maskFeather) && item.form.maskFeather >= 0
            ? item.form.maskFeather
            : DEFAULT_FORM.maskFeather;
        for (let i = 0; i < images.length; i++) {
          if (!isCurrentRun(runToken)) return;
          const info = await placeImageIntoSelection(toDataUrl(images[i]), i + 1, {
            feather
          });
          if (!isCurrentRun(runToken)) return;
          const id = extractLayerId(info);
          if (id) {
            placedLayerIds.push(id);
          }
        }
        if (placedLayerIds.length > 1) {
          await groupLayers(placedLayerIds, item.name).catch((error) =>
            console.warn("groupLayers failed", error)
          );
          if (!isCurrentRun(runToken)) return;
        }
        await moveActiveLayerToTop();
        if (!isCurrentRun(runToken)) return;
        setBatchItems((items) => items.map((candidate) =>
          candidate.id === item.id ? { ...candidate, status: "success", error: undefined } : candidate
        ));
        setProgress(0);
      }
      setStatus("success");
      pushToast("success", "批次执行完成");
    } catch (caught) {
      stopPolling();
      if (!isCurrentRun(runToken)) return;
      if (isGenerationCancelledError(caught)) {
        if (activeItemId) {
          setBatchItems((items) => items.map((item) =>
            item.id === activeItemId ? { ...item, status: "stopped", error: undefined } : item
          ));
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
        setBatchItems((items) => items.map((item) =>
          item.id === activeItemId ? { ...item, status: "error", error: message } : item
        ));
      }
      setStatus("error");
      setError(message);
      pushToast("error", message);
    } finally {
      stopPolling();
      if (isCurrentRun(runToken)) {
        runGateRef.current.complete(runToken);
        setProgress(0);
      }
    }
  }, [batchItems, client, imageModelClient, isCurrentRun, pollProgress, pushToast, settings, stopPolling]);

  const applyPreset = useCallback(
    async (fileName: string) => {
      const file = await loadPresetFile<PresetPayload>(fileName);
      if (!file?.data?.form) {
        throw new Error("预设文件格式不正确");
      }
      setForm((prev) => ({
        ...prev,
        ...DEFAULT_FORM,
        ...file.data.form
      }));
      setSelectedPreset(file.meta.name);
      pushToast("success", `已应用预设「${file.meta.name}」`);
    },
    [pushToast]
  );

  const savePreset = useCallback(
    async (name: string) => {
      presetsLoadGateRef.current.assertReady("预设仍在加载，请稍后重试");
      await savePresetFile<PresetPayload>(name, { form });
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
    setPresetShortcut,
    status,
    progress,
    error,
    lastImages,
    options,
    optionsLoading,
    optionsError,
    refreshOptions,
    runGeneration,
    stopGeneration,
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
