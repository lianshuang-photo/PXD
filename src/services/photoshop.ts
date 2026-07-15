import { bridge } from "./uxpBridge";
import { runPSExclusive } from "./psLock";

export interface SelectionBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface SelectionPixels {
  dataUrl: string;
  width: number;
  height: number;
  selectionBounds: SelectionBounds;
}

export interface CapturedAtlasRegion {
  id: string;
  documentId: number;
  bounds: SelectionBounds;
  sourceWidth: number;
  sourceHeight: number;
  imageWidth: number;
  imageHeight: number;
  dataUrl: string;
  encodedBytes: number;
}

export interface AtlasPlacementPart {
  regionId: string;
  dataUrl: string;
  width: number;
  height: number;
}

export interface AtlasPlacementOptions extends PhotoshopOperationOptions {
  isCurrent?: () => boolean;
  groupName?: string;
}

export interface AtlasPlacementResult {
  layerIds: number[];
  groupId: number;
}

export class AtlasPlacementError extends Error {
  readonly issues: Array<{ phase: string; error: unknown }>;
  readonly recoveryFailed: boolean;

  constructor(issues: Array<{ phase: string; error: unknown }>) {
    super(issues.map(({ phase, error }) =>
      `${phase}：${error instanceof Error ? error.message : String(error)}`
    ).join("；"));
    this.name = "AtlasPlacementError";
    this.issues = issues;
    this.recoveryFailed = issues.some(({ phase }) => phase !== "多区贴回");
  }
}

export interface PhotoshopOperationOptions {
  taskId?: string;
  timeoutMs?: number;
}

export interface PlaceImageOptions extends PhotoshopOperationOptions {
  feather?: number;
}

export interface MoveLayerOptions extends PhotoshopOperationOptions {
  layerId: number;
}

const DEFAULT_MODAL_OPTIONS = { commandName: "PXDUI" };

const getPhotoshop = () => bridge.photoshop;
const getUxp = () => bridge.uxp;

const ensureModule = <T>(moduleGetter: () => T | undefined, name: string): T => {
  const mod = moduleGetter();
  if (!mod) {
    throw new Error(`${name} module is not available in this environment`);
  }
  return mod;
};

const executeAsModalUnlocked = <T>(
  photoshop: any,
  operation: () => Promise<T>,
  options: Record<string, unknown>
): Promise<T> => photoshop.core.executeAsModal(operation, options);

const runTransaction = <T>(
  operation: () => Promise<T>,
  options: PhotoshopOperationOptions = {}
): Promise<T> => runPSExclusive(operation, {
  taskId: options.taskId,
  timeoutMs: options.timeoutMs
});

const toBounds = (bounds: any): SelectionBounds => ({
  left: Math.round(Number(bounds.left)),
  top: Math.round(Number(bounds.top)),
  right: Math.round(Number(bounds.right)),
  bottom: Math.round(Number(bounds.bottom))
});

const createTempTokenFromBase64 = async (base64: string, fileName: string) => {
  const uxp = ensureModule(getUxp, "UXP");
  const tmp = await uxp.storage.localFileSystem.getTemporaryFolder();
  const file = await tmp.createFile(fileName, { overwrite: true });
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  await file.write(bytes, { format: uxp.storage.formats.binary });
  return await uxp.storage.localFileSystem.createSessionToken(file);
};

const selectionToRectangle = (bounds: SelectionBounds) => ({
  _obj: "rectangle",
  top: { _unit: "pixelsUnit", _value: bounds.top },
  left: { _unit: "pixelsUnit", _value: bounds.left },
  bottom: { _unit: "pixelsUnit", _value: bounds.bottom },
  right: { _unit: "pixelsUnit", _value: bounds.right }
});

const MASK_CONTRACT_RATIO = 0.025;
const MASK_FEATHER_RATIO = 0.08;
const MASK_MAX_CONTRACT = 120;
const MASK_MAX_FEATHER = 1200;
const DEFAULT_GROUP_NAME = "PXD生成结果";

const runJsxCodeUnlocked = async (jsx: string) => {
  const photoshop = ensureModule(getPhotoshop, "Photoshop");
  const folder = await bridge.getDataFolder();
  if (!folder) return null;
  const file = await folder.createFile("runner.jsx", { overwrite: true });
  await file.write(jsx);
  const token = await bridge.createSessionToken?.(file);
  if (!token) return null;
  const descriptor = {
    _obj: "AdobeScriptAutomation Scripts",
    javaScript: {
      _kind: "local",
      _path: token
    },
    javaScriptMessage: "undefined",
    _options: {
      dialogOptions: "dontDisplay"
    }
  };
  return await photoshop.core.executeAsModal(
    async () => {
      return await photoshop.app.batchPlay([descriptor], {
        modalBehavior: "execute",
        synchronousExecution: false
      });
    },
    { commandName: "run jsx code" }
  );
};

const computeMaskAdjustments = (bounds: SelectionBounds, featherOverride?: number) => {
  const width = Math.max(0, bounds.right - bounds.left);
  const height = Math.max(0, bounds.bottom - bounds.top);
  const minSize = Math.max(1, Math.min(width, height));
  const maxContract = Math.max(0, Math.floor(minSize / 2) - 1);
  const maxFeather = Math.max(0, Math.floor(minSize / 2));
  let feather = Math.max(
    0,
    Math.min(
      Math.round(minSize * MASK_FEATHER_RATIO),
      maxFeather,
      MASK_MAX_FEATHER
    )
  );
  const hasOverride = typeof featherOverride === "number" && Number.isFinite(featherOverride);
  if (hasOverride) {
    feather = Math.max(
      0,
      Math.min(Math.round(featherOverride as number), maxFeather, MASK_MAX_FEATHER)
    );
  }
  let contract = feather;
  return { contract, feather };
};

const resizeActiveLayerToBounds = async (bounds: SelectionBounds) => {
  const jsx = `
        try {
            var doc = app.activeDocument;
            if (!doc) { true; }
            var layer = doc.activeLayer;
            if (!layer) { true; }
            var selectionLeft = ${JSON.stringify(bounds.left)};
            var selectionTop = ${JSON.stringify(bounds.top)};
            var selectionRight = ${JSON.stringify(bounds.right)};
            var selectionBottom = ${JSON.stringify(bounds.bottom)};
            var selectionWidth = selectionRight - selectionLeft;
            var selectionHeight = selectionBottom - selectionTop;
            if (selectionWidth <= 0 || selectionHeight <= 0) { true; }
            var layerBounds = layer.bounds;
            var layerLeft = layerBounds[0].as("px");
            var layerTop = layerBounds[1].as("px");
            var layerRight = layerBounds[2].as("px");
            var layerBottom = layerBounds[3].as("px");
            var layerWidth = layerRight - layerLeft;
            var layerHeight = layerBottom - layerTop;
            if (layerWidth === 0 || layerHeight === 0) { true; }
            var scaleX = (selectionWidth / layerWidth) * 100;
            var scaleY = (selectionHeight / layerHeight) * 100;
            layer.resize(scaleX, scaleY, AnchorPosition.TOPLEFT);
            layerBounds = layer.bounds;
            var newLeft = layerBounds[0].as("px");
            var newTop = layerBounds[1].as("px");
            layer.translate(selectionLeft - newLeft, selectionTop - newTop);
            true;
        } catch (e) {
            false;
        }
    `;
  try {
    await runJsxCodeUnlocked(jsx);
  } catch (error) {
    console.warn("resizeActiveLayerToBounds failed", error);
  }
};

const tryCreateMaskFromSelection = async (hasSelection: boolean) => {
  try {
    const photoshop = ensureModule(getPhotoshop, "Photoshop");
    await executeAsModalUnlocked(photoshop, async () => {
      await photoshop.app.batchPlay(
        [
          {
            _obj: "make",
            at: {
              _enum: "channel",
              _ref: "channel",
              _value: "mask"
            },
            new: {
              _class: "channel"
            },
            using: {
              _enum: "userMaskEnabled",
              _value: hasSelection ? "revealSelection" : "revealAll"
            }
          }
        ],
        { synchronousExecution: true }
      );
    }, DEFAULT_MODAL_OPTIONS);
  } catch (error) {
    console.warn("create mask failed", error);
  }
};

const adjustSelectionForMask = async (bounds: SelectionBounds, featherOverride?: number) => {
  const { contract, feather } = computeMaskAdjustments(bounds, featherOverride);
  if (contract <= 0 && feather <= 0) {
    return;
  }
  const jsx = `
        try {
            var doc = app.activeDocument;
            if (!doc) { true; }
            var selection = doc.selection;
            if (!selection) { true; }
            ${contract > 0 ? `selection.contract(${contract});` : ""}
            ${feather > 0 ? `selection.feather(${feather});` : ""}
            true;
        } catch (e) {
            false;
        }
    `;
  try {
    await runJsxCodeUnlocked(jsx);
  } catch (error) {
    console.warn("adjustSelectionForMask failed", error);
  }
};

const uniqueLayerIds = (layerIds: number[]) =>
  Array.from(
    new Set(
      layerIds
        .map((id) => Number.parseInt(String(id), 10))
        .filter((id) => Number.isFinite(id) && id > 0)
    )
  );

export interface GroupLayersOptions extends PhotoshopOperationOptions {
  requireGroup?: boolean;
}

const groupLayersUnlocked = async (
  layerIds: number[],
  groupName: string,
  options: { requireGroup?: boolean } = {}
): Promise<number | null> => {
  const photoshop = ensureModule(getPhotoshop, "Photoshop");
  const ids = uniqueLayerIds(layerIds);
  if (!ids.length) {
    return null;
  }
  const jsx = `
        try {
            var ids = ${JSON.stringify(ids)};
            if (!ids || !ids.length) { false; }
            var ref = new ActionReference();
            for (var i = 0; i < ids.length; i++) {
                ref.putIdentifier(charIDToTypeID("Lyr "), ids[i]);
            }
            var desc = new ActionDescriptor();
            desc.putReference(charIDToTypeID("null"), ref);
            app.executeAction(charIDToTypeID("slct"), desc, DialogModes.NO);

            var makeDesc = new ActionDescriptor();
            var makeRef = new ActionReference();
            makeRef.putClass(stringIDToTypeID("layerSection"));
            makeDesc.putReference(charIDToTypeID("null"), makeRef);
            var fromRef = new ActionReference();
            fromRef.putEnumerated(charIDToTypeID("Lyr "), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
            makeDesc.putReference(charIDToTypeID("From"), fromRef);
            makeDesc.putString(charIDToTypeID("Nm  "), ${JSON.stringify(groupName)});
            app.executeAction(charIDToTypeID("Mk  "), makeDesc, DialogModes.NO);
            true;
        } catch (e) {
            false;
        }
    `;
  try {
    await runJsxCodeUnlocked(jsx);
  } catch (error) {
    if (options.requireGroup) throw error;
    console.warn("groupLayers failed", error);
  }
  try {
    const info = await executeAsModalUnlocked(photoshop, async () => {
      const result = await photoshop.app.batchPlay(
        [
          {
            _obj: "get",
            _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }]
          }
        ],
        { synchronousExecution: true }
      );
      return result[0];
    }, DEFAULT_MODAL_OPTIONS);
    const id = Number(
      info?.layerID ?? info?.layerId ?? info?.targetLayerID ?? info?.targetLayerId ?? 0
    );
    const layerSection = info?.layerSection?._value ?? info?.layerSection;
    const groupId = Number.isFinite(id) && id > 0 ? id : null;
    if (options.requireGroup && (!groupId || layerSection !== "layerSectionStart")) {
      throw new Error("Photoshop 未创建预期的图层组");
    }
    return groupId;
  } catch (error) {
    if (options.requireGroup) throw error;
    console.warn("groupLayers get info failed", error);
    return null;
  }
};

export const groupLayers = (
  layerIds: number[],
  groupName = DEFAULT_GROUP_NAME,
  options: GroupLayersOptions = {}
): Promise<number | null> => runTransaction(() => groupLayersUnlocked(layerIds, groupName, options), options);

const hasActiveSelectionUnlocked = async (): Promise<boolean> => {
  try {
    const photoshop = ensureModule(getPhotoshop, "Photoshop");
    const doc = photoshop.app.activeDocument;
    return Boolean(doc?.selection?.bounds);
  } catch {
    return false;
  }
};

export const hasActiveSelection = (
  options: PhotoshopOperationOptions = {}
): Promise<boolean> => runTransaction(hasActiveSelectionUnlocked, options);

const getSelectionPixelsUnlocked = async (): Promise<SelectionPixels | null> => {
  try {
    const photoshop = ensureModule(getPhotoshop, "Photoshop");
    const doc = photoshop.app.activeDocument;
    if (!doc?.selection?.bounds) {
      return null;
    }
    const bounds = toBounds(doc.selection.bounds);
    return await executeAsModalUnlocked(
      photoshop,
      async () => {
        const options = {
          documentID: doc.id,
          sourceBounds: bounds,
          applyAlpha: true,
          componentSize: 8,
          colorProfile: "sRGB IEC61966-2.1"
        };
        const pixels = await photoshop.imaging.getPixels(options);
        const encoded = await photoshop.imaging.encodeImageData({
          imageData: pixels.imageData,
          base64: true
        });
        pixels.imageData.dispose?.();
        const width = bounds.right - bounds.left;
        const height = bounds.bottom - bounds.top;
        return {
          dataUrl: `data:image/png;base64,${encoded}`,
          width,
          height,
          selectionBounds: bounds
        };
      },
      DEFAULT_MODAL_OPTIONS
    );
  } catch (error) {
    console.error("Failed to get selection pixels", error);
    return null;
  }
};

export const getSelectionPixels = (
  options: PhotoshopOperationOptions = {}
): Promise<SelectionPixels | null> => runTransaction(getSelectionPixelsUnlocked, options);

const setSelectionBoundsUnlocked = async (bounds: SelectionBounds) => {
  const photoshop = ensureModule(getPhotoshop, "Photoshop");
  await executeAsModalUnlocked(photoshop, async () => {
    await photoshop.app.batchPlay(
      [
        {
          _obj: "set",
          _target: [{ _ref: "channel", _property: "selection" }],
          to: selectionToRectangle(bounds)
        }
      ],
      {}
    );
  }, DEFAULT_MODAL_OPTIONS);
};

export const setSelectionBounds = (
  bounds: SelectionBounds,
  options: PhotoshopOperationOptions = {}
): Promise<void> => runTransaction(() => setSelectionBoundsUnlocked(bounds), options);

const placeImageIntoSelectionUnlocked = async (
  dataUrl: string,
  index = 1,
  options: PlaceImageOptions = {}
) => {
  const photoshop = ensureModule(getPhotoshop, "Photoshop");
  const base64 = dataUrl.includes(",") ? dataUrl.split(",").pop() ?? dataUrl : dataUrl;
  const doc = photoshop.app.activeDocument;
  let cachedBounds: SelectionBounds | null = null;
  if (doc.selection?.bounds) {
    cachedBounds = toBounds(doc.selection.bounds);
  }
  const userFeather =
    typeof options?.feather === "number" && Number.isFinite(options.feather)
      ? options.feather
      : undefined;

  const token = await createTempTokenFromBase64(base64, `img-${index}.png`);

  await executeAsModalUnlocked(
    photoshop,
    async () => {
      const steps: any[] = [
        {
          ID: doc.id,
          _obj: "placeEvent",
          freeTransformCenterState: {
            _enum: "quadCenterState",
            _value: "QCSAverage"
          },
          null: {
            _kind: "local",
            _path: token
          },
          offset: {
            _obj: "offset",
            horizontal: { _unit: "pixelsUnit", _value: 0 },
            vertical: { _unit: "pixelsUnit", _value: 0 }
          }
        }
      ];
      if (cachedBounds) {
        steps.push({
          _obj: "set",
          _target: [{ _ref: "channel", _property: "selection" }],
          to: selectionToRectangle(cachedBounds)
        });
      }
      await photoshop.app.batchPlay(steps, {});
    },
    { commandName: "import image file" }
  );

  const info = await executeAsModalUnlocked(photoshop, async () => {
    const result = await photoshop.app.batchPlay(
      [
        {
          _obj: "get",
          _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }]
        }
      ],
      { synchronousExecution: true }
    );
    return result[0];
  }, DEFAULT_MODAL_OPTIONS);
  if (cachedBounds) {
    await setSelectionBoundsUnlocked(cachedBounds).catch((error) => console.warn("restore selection failed", error));
    await resizeActiveLayerToBounds(cachedBounds);
    await setSelectionBoundsUnlocked(cachedBounds).catch((error) => console.warn("restore selection failed", error));
    await adjustSelectionForMask(cachedBounds, userFeather);
    await tryCreateMaskFromSelection(true);
    await setSelectionBoundsUnlocked(cachedBounds).catch((error) => console.warn("restore selection failed", error));
  } else {
    await tryCreateMaskFromSelection(false);
  }
  return info;
};

export interface GeneratedDocumentSession {
  documentId: number;
  previousDocumentId: number | null;
}

const createGeneratedDocumentUnlocked = async (
  width: number,
  height: number,
  name = "PXD 文生图"
): Promise<GeneratedDocumentSession> => {
  const photoshop = ensureModule(getPhotoshop, "Photoshop");
  const documentWidth = Math.max(32, Math.round(width));
  const documentHeight = Math.max(32, Math.round(height));
  let previousDocumentId: number | null = null;
  try {
    const previousIdCandidate = Number(photoshop.app.activeDocument?.id);
    if (Number.isFinite(previousIdCandidate) && previousIdCandidate > 0) {
      previousDocumentId = previousIdCandidate;
    }
  } catch {
    // Text-to-image also supports starting with no open Photoshop document.
  }
  const documentId = await executeAsModalUnlocked(photoshop, async () => {
    if (typeof photoshop.app.createDocument === "function") {
      try {
        const document = await photoshop.app.createDocument({
          width: documentWidth,
          height: documentHeight,
          resolution: 72,
          mode: "RGBColorMode",
          fill: "transparent",
          name
        });
        const id = Number(document?.id);
        if (Number.isFinite(id) && id > 0) return id;
      } catch (error) {
        console.warn("Photoshop createDocument failed, falling back to batchPlay", error);
      }
    }
    const result = await photoshop.app.batchPlay(
      [
        {
          _obj: "make",
          _target: [{ _ref: "document" }],
          using: {
            _obj: "document",
            name,
            width: { _unit: "pixelsUnit", _value: documentWidth },
            height: { _unit: "pixelsUnit", _value: documentHeight },
            resolution: { _unit: "densityUnit", _value: 72 },
            mode: { _class: "RGBColorMode" },
            fill: { _enum: "fill", _value: "transparent" }
          }
        }
      ],
      { synchronousExecution: true }
    );
    const descriptor = result?.[0];
    const descriptorId = Number(
      descriptor?.documentID ?? descriptor?.documentId ?? descriptor?.ID ?? descriptor?.id
    );
    if (Number.isFinite(descriptorId) && descriptorId > 0) return descriptorId;
    const activeId = Number(photoshop.app.activeDocument?.id);
    if (!Number.isFinite(activeId) || activeId <= 0) {
      throw new Error("Photoshop 未返回新建文档 ID");
    }
    return activeId;
  }, { commandName: "创建 PXD 文生图画布" });
  return { documentId, previousDocumentId };
};

const closeGeneratedDocumentUnlocked = async (
  documentId: number,
  restoreDocumentId: number | null
): Promise<void> => {
  const photoshop = ensureModule(getPhotoshop, "Photoshop");
  let cleanupError: unknown;
  try {
    await executeAsModalUnlocked(photoshop, async () => {
      await photoshop.app.batchPlay(
        [
          {
            _obj: "close",
            _target: [{ _ref: "document", _id: documentId }],
            saving: { _enum: "yesNo", _value: "no" }
          }
        ],
        { synchronousExecution: true }
      );
    }, { commandName: "关闭失败的 PXD 文生图画布" });
  } catch (error) {
    cleanupError = error;
  }
  if (restoreDocumentId) {
    try {
      await executeAsModalUnlocked(photoshop, async () => {
        await photoshop.app.batchPlay(
          [{ _obj: "select", _target: [{ _ref: "document", _id: restoreDocumentId }] }],
          { synchronousExecution: true }
        );
      }, { commandName: "恢复原 Photoshop 文档" });
    } catch (error) {
      cleanupError ??= error;
    }
  }
  if (cleanupError) throw cleanupError;
};


export const createGeneratedDocument = (
  width: number,
  height: number,
  name = "PXD 文生图",
  options: PhotoshopOperationOptions = {}
): Promise<GeneratedDocumentSession> =>
  runTransaction(() => createGeneratedDocumentUnlocked(width, height, name), options);

export const closeGeneratedDocument = (
  documentId: number,
  restoreDocumentId: number | null,
  options: PhotoshopOperationOptions = {}
): Promise<void> =>
  runTransaction(() => closeGeneratedDocumentUnlocked(documentId, restoreDocumentId), options);

export const placeImageIntoSelection = (
  dataUrl: string,
  index = 1,
  options: PlaceImageOptions = {}
) => runTransaction(() => placeImageIntoSelectionUnlocked(dataUrl, index, options), options);

const placeImageIntoDocumentUnlocked = async (dataUrl: string, index = 1, docId?: number) => {
  const photoshop = ensureModule(getPhotoshop, "Photoshop");
  const doc = photoshop.app.activeDocument;
  const base64 = dataUrl.includes(",") ? dataUrl.split(",").pop() ?? dataUrl : dataUrl;
  const token = await createTempTokenFromBase64(base64, `imgdoc-${index}.png`);

  await executeAsModalUnlocked(
    photoshop,
    async () => {
      const steps: any[] = [
        {
          ID: docId ?? doc.id,
          _obj: "placeEvent",
          freeTransformCenterState: {
            _enum: "quadCenterState",
            _value: "QCSAverage"
          },
          null: {
            _kind: "local",
            _path: token
          },
          offset: {
            _obj: "offset",
            horizontal: { _unit: "pixelsUnit", _value: 0 },
            vertical: { _unit: "pixelsUnit", _value: 0 }
          }
        }
      ];
      await photoshop.app.batchPlay(steps, {});
    },
    { commandName: "import image file" }
  );

  const info = await executeAsModalUnlocked(photoshop, async () => {
    const result = await photoshop.app.batchPlay(
      [
        {
          _obj: "get",
          _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }]
        }
      ],
      { synchronousExecution: true }
    );
    return result[0];
  }, DEFAULT_MODAL_OPTIONS);
  return info;
};

export const placeImageIntoDocument = (
  dataUrl: string,
  index = 1,
  docId?: number,
  options: PhotoshopOperationOptions = {}
) => runTransaction(() => placeImageIntoDocumentUnlocked(dataUrl, index, docId), options);

const moveActiveLayerToTopUnlocked = async (layerId: number) => {
  const photoshop = ensureModule(getPhotoshop, "Photoshop");
  await executeAsModalUnlocked(photoshop, async () => {
    await photoshop.app.batchPlay(
      [
        {
          _obj: "move",
          _target: [{ _ref: "layer", _id: layerId }],
          to: { _ref: "layer", _enum: "ordinal", _value: "front" }
        }
      ],
      {}
    );
  }, DEFAULT_MODAL_OPTIONS);
};

export const moveActiveLayerToTop = (
  options: MoveLayerOptions
): Promise<void> => runTransaction(() => moveActiveLayerToTopUnlocked(options.layerId), options);

const closeDocumentUnlocked = async (docId: number, activeDocId: number, newLayerId: number) => {
  const jsx = `
        try {
            var descSelectDoc = new ActionDescriptor();
            var refSelectDoc = new ActionReference();
            refSelectDoc.putIdentifier(charIDToTypeID("Dcmn"), parseInt(${docId}));
            descSelectDoc.putReference(stringIDToTypeID("null"), refSelectDoc);
            app.executeAction(stringIDToTypeID("select"), descSelectDoc, DialogModes.NO);

            var descClose = new ActionDescriptor();
            descClose.putEnumerated(charIDToTypeID("Svng"), charIDToTypeID("YsN "), charIDToTypeID("YsN "));
            app.executeAction(charIDToTypeID("Cls "), descClose, DialogModes.NO);

            var descSelectActiveDoc = new ActionDescriptor();
            var refSelectActiveDoc = new ActionReference();
            refSelectActiveDoc.putIdentifier(charIDToTypeID("Dcmn"), parseInt(${activeDocId}));
            descSelectActiveDoc.putReference(stringIDToTypeID("null"), refSelectActiveDoc);
            app.executeAction(stringIDToTypeID("select"), descSelectActiveDoc, DialogModes.NO);

            var current = new ActionReference();
            current.putIdentifier(app.charIDToTypeID("Lyr "), ${newLayerId});
            var desc = new ActionDescriptor();
            desc.putReference(app.charIDToTypeID("null"), current);
            app.executeAction(app.charIDToTypeID("slct"), desc, DialogModes.NO);

            var descDeleteLayer = new ActionDescriptor();
            var refDeleteLayer = new ActionReference();
            refDeleteLayer.putEnumerated(charIDToTypeID("Lyr "), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
            descDeleteLayer.putReference(charIDToTypeID("null"), refDeleteLayer);
            var listDeleteLayerIds = new ActionList();
            listDeleteLayerIds.putInteger(${newLayerId});
            descDeleteLayer.putList(charIDToTypeID("LyrI"), listDeleteLayerIds);
            executeAction(charIDToTypeID("Dlt "), descDeleteLayer, DialogModes.NO);
        } catch (error) {}
    `;
  await runJsxCodeUnlocked(jsx);
};

export const closeDocument = (
  docId: number,
  activeDocId: number,
  newLayerId: number,
  options: PhotoshopOperationOptions = {}
): Promise<void> => runTransaction(() => closeDocumentUnlocked(docId, activeDocId, newLayerId), options);

const onBatchAddLayerUnlocked = async (): Promise<[number, number, number] | null> => {
  const result = await runJsxCodeUnlocked(`
        try {
            var activeDoc = app.activeDocument;
            var activeDocId = activeDoc.id;
            var targetLayer = app.activeDocument.activeLayer;
            
            var idCpTL = charIDToTypeID( "CpTL" );
            executeAction( idCpTL, undefined, DialogModes.NO );

            var idnewPlacedLayer = stringIDToTypeID( "newPlacedLayer" );
            executeAction( idnewPlacedLayer, undefined, DialogModes.NO );

            var idMk = charIDToTypeID( "Mk  " );
            var desc661 = new ActionDescriptor();
            var idNw = charIDToTypeID( "Nw  " );
            var idChnl = charIDToTypeID( "Chnl" );
            desc661.putClass( idNw, idChnl );
            var idAt = charIDToTypeID( "At  " );
            var ref46 = new ActionReference();
            var idChnl = charIDToTypeID( "Chnl" );
            var idChnl = charIDToTypeID( "Chnl" );
            var idMsk = charIDToTypeID( "Msk " );
            ref46.putEnumerated( idChnl, idChnl, idMsk );
            desc661.putReference( idAt, ref46 );
            var idUsng = charIDToTypeID( "Usng" );
            var idUsrM = charIDToTypeID( "UsrM" );
            var idRvlA = charIDToTypeID( "RvlA" );
            desc661.putEnumerated( idUsng, idUsrM, idRvlA );
            executeAction( idMk, desc661, DialogModes.NO );

            var newLayer = app.activeDocument.activeLayer;
            var newLayerId = newLayer.id;

            var idplacedLayerEditContents = stringIDToTypeID( "placedLayerEditContents" );
            var desc717 = new ActionDescriptor();
            executeAction( idplacedLayerEditContents, desc717, DialogModes.NO );
            var createDocId = app.activeDocument.id;
            app.activeDocument = activeDoc;
            app.activeDocument.activeLayer = targetLayer;
            [activeDocId, createDocId, newLayerId];
        } catch (error) {
            [0, 0, 0];
        }
    `);
  if (!result || !Array.isArray(result) || !result[0]) {
    return null;
  }
  const [batch] = result;
  const tuple = batch?.javaScriptMessage?.split?.(",") ?? [];
  if (tuple.length < 3) {
    return null;
  }
  const [activeDocId, createDocId, newLayerId] = tuple.map((value) => Number.parseInt(value, 10));
  return [activeDocId, createDocId, newLayerId];
};

export const onBatchAddLayer = (
  options: PhotoshopOperationOptions = {}
): Promise<[number, number, number] | null> => runTransaction(onBatchAddLayerUnlocked, options);

const switchToDocumentUnlocked = async (docId: number) => {
  const photoshop = ensureModule(getPhotoshop, "Photoshop");
  await executeAsModalUnlocked(photoshop, async () => {
    await photoshop.app.batchPlay(
      [
        {
          _obj: "select",
          _target: [{ _ref: "document", _id: docId }]
        }
      ],
      {}
    );
  }, DEFAULT_MODAL_OPTIONS);
};

export const switchToDocument = (
  docId: number,
  options: PhotoshopOperationOptions = {}
): Promise<void> => runTransaction(() => switchToDocumentUnlocked(docId), options);

const base64ByteLength = (value: string) => {
  const base64 = value.replace(/\s/g, "");
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(base64.length * 3 / 4) - padding);
};

export const captureAtlasRegion = (
  targetMaxEdge: number,
  options: PhotoshopOperationOptions = {}
): Promise<CapturedAtlasRegion> => runTransaction(async () => {
  const photoshop = ensureModule(getPhotoshop, "Photoshop");
  const doc = photoshop.app.activeDocument;
  const documentId = Number(doc?.id);
  if (!Number.isInteger(documentId) || documentId <= 0 || !doc?.selection?.bounds) {
    throw new Error("请先在 Photoshop 中选择一个有效区域");
  }
  const bounds = toBounds(doc.selection.bounds);
  const sourceWidth = bounds.right - bounds.left;
  const sourceHeight = bounds.bottom - bounds.top;
  const maxEdge = Math.max(128, Math.min(2048, Math.round(targetMaxEdge)));
  if (sourceWidth <= 0 || sourceHeight <= 0) throw new Error("当前 Photoshop 选区尺寸无效");
  const scale = Math.min(1, maxEdge / Math.max(sourceWidth, sourceHeight));
  const imageWidth = Math.max(1, Math.round(sourceWidth * scale));
  const imageHeight = Math.max(1, Math.round(sourceHeight * scale));
  const encoded = await executeAsModalUnlocked(photoshop, async () => {
    const pixels = await photoshop.imaging.getPixels({
      documentID: documentId,
      sourceBounds: bounds,
      targetSize: { width: imageWidth, height: imageHeight },
      applyAlpha: true,
      componentSize: 8,
      colorProfile: "sRGB IEC61966-2.1"
    });
    try {
      return String(await photoshop.imaging.encodeImageData({
        imageData: pixels.imageData,
        base64: true
      }));
    } finally {
      pixels.imageData.dispose?.();
    }
  }, { commandName: "抓取 PXD 多区选区" });
  if (!encoded) throw new Error("Photoshop 未返回选区图像数据");
  return {
    id: `atlas-${documentId}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    documentId,
    bounds,
    sourceWidth,
    sourceHeight,
    imageWidth,
    imageHeight,
    dataUrl: `data:image/png;base64,${encoded}`,
    encodedBytes: base64ByteLength(encoded)
  };
}, options);

const activeLayerIdUnlocked = async (): Promise<number | null> => {
  const photoshop = ensureModule(getPhotoshop, "Photoshop");
  const domId = Number(photoshop.app.activeDocument?.activeLayers?.[0]?.id ?? photoshop.app.activeDocument?.activeLayer?.id);
  if (Number.isInteger(domId) && domId > 0) return domId;
  const info = await executeAsModalUnlocked(photoshop, async () => {
    const result = await photoshop.app.batchPlay(
      [{ _obj: "get", _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }] }],
      { synchronousExecution: true }
    );
    return result[0];
  }, DEFAULT_MODAL_OPTIONS);
  const id = Number(info?.layerID ?? info?.layerId ?? info?.targetLayerID ?? info?.targetLayerId);
  return Number.isInteger(id) && id > 0 ? id : null;
};

const deleteLayersUnlocked = async (layerIds: number[]) => {
  const ids = uniqueLayerIds(layerIds);
  if (!ids.length) return;
  const photoshop = ensureModule(getPhotoshop, "Photoshop");
  await executeAsModalUnlocked(photoshop, async () => {
    await photoshop.app.batchPlay(
      ids.map((id) => ({ _obj: "delete", _target: [{ _ref: "layer", _id: id }] })),
      { synchronousExecution: true }
    );
  }, { commandName: "清理 PXD 多区输出" });
};

const renameLayerUnlocked = async (layerId: number, name: string) => {
  const photoshop = ensureModule(getPhotoshop, "Photoshop");
  await executeAsModalUnlocked(photoshop, async () => {
    await photoshop.app.batchPlay([{
      _obj: "set",
      _target: [{ _ref: "layer", _id: layerId }],
      to: { _obj: "layer", name }
    }], { synchronousExecution: true });
  }, DEFAULT_MODAL_OPTIONS);
};

const restoreSelectionUnlocked = async (bounds: SelectionBounds | null) => {
  if (bounds) {
    await setSelectionBoundsUnlocked(bounds);
    return;
  }
  const photoshop = ensureModule(getPhotoshop, "Photoshop");
  await executeAsModalUnlocked(photoshop, async () => {
    await photoshop.app.batchPlay([{
      _obj: "set",
      _target: [{ _ref: "channel", _property: "selection" }],
      to: { _enum: "ordinal", _value: "none" }
    }], { synchronousExecution: true });
  }, DEFAULT_MODAL_OPTIONS);
};

const atlasUnitValue = (value: unknown) => {
  if (typeof value === "number") return value;
  if (value && typeof value === "object") {
    const record = value as { _value?: unknown; value?: unknown };
    const candidate = Number(record._value ?? record.value);
    if (Number.isFinite(candidate)) return candidate;
  }
  return Number(value);
};

const resizeAtlasLayerUnlocked = async (
  layerId: number,
  layerBounds: unknown,
  target: SelectionBounds
) => {
  const photoshop = ensureModule(getPhotoshop, "Photoshop");
  const record = layerBounds as Record<string, unknown> | null;
  const left = atlasUnitValue(record?.left);
  const top = atlasUnitValue(record?.top);
  const right = atlasUnitValue(record?.right);
  const bottom = atlasUnitValue(record?.bottom);
  const width = right - left;
  const height = bottom - top;
  const targetWidth = target.right - target.left;
  const targetHeight = target.bottom - target.top;
  if (![left, top, right, bottom, width, height, targetWidth, targetHeight].every(Number.isFinite) ||
      width <= 0 || height <= 0 || targetWidth <= 0 || targetHeight <= 0) {
    throw new Error("Photoshop 未返回可严格定位的多区图层");
  }
  await executeAsModalUnlocked(photoshop, async () => {
    await photoshop.app.batchPlay([{
      _obj: "transform",
      _target: [{ _ref: "layer", _id: layerId }],
      freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSAverage" },
      width: { _unit: "percentUnit", _value: targetWidth / width * 100 },
      height: { _unit: "percentUnit", _value: targetHeight / height * 100 },
      offset: {
        _obj: "offset",
        horizontal: { _unit: "pixelsUnit", _value: (target.left + target.right - left - right) / 2 },
        vertical: { _unit: "pixelsUnit", _value: (target.top + target.bottom - top - bottom) / 2 }
      }
    }], { synchronousExecution: true });
  }, { commandName: "严格定位 PXD 多区图层" });
  const verified = await executeAsModalUnlocked(photoshop, async () => {
    const result = await photoshop.app.batchPlay(
      [{ _obj: "get", _target: [{ _ref: "layer", _id: layerId }] }],
      { synchronousExecution: true }
    );
    return result[0];
  }, DEFAULT_MODAL_OPTIONS);
  const verifiedBounds = verified?.bounds ?? verified?.boundsNoEffects;
  const actual = {
    left: atlasUnitValue(verifiedBounds?.left),
    top: atlasUnitValue(verifiedBounds?.top),
    right: atlasUnitValue(verifiedBounds?.right),
    bottom: atlasUnitValue(verifiedBounds?.bottom)
  };
  if (Object.keys(actual).some((key) =>
    Math.abs(actual[key as keyof typeof actual] - target[key as keyof SelectionBounds]) > 1.5
  )) {
    throw new Error("Photoshop 未将多区图层严格定位到原选区");
  }
};

export const placeMultiRegionAtlas = (
  documentId: number,
  regions: CapturedAtlasRegion[],
  parts: AtlasPlacementPart[],
  options: AtlasPlacementOptions = {}
): Promise<AtlasPlacementResult> => runTransaction(async () => {
  const photoshop = ensureModule(getPhotoshop, "Photoshop");
  const sourceDocumentId = Number(documentId);
  const restoreDocumentId = Number(photoshop.app.activeDocument?.id) || null;
  if (!Number.isInteger(sourceDocumentId) || sourceDocumentId <= 0 || !regions.length || regions.length !== parts.length) {
    throw new Error("多区贴回参数无效");
  }
  for (let index = 0; index < regions.length; index += 1) {
    if (regions[index].documentId !== sourceDocumentId || regions[index].id !== parts[index].regionId) {
      throw new Error("多区贴回账本与 Photoshop 选区不一致");
    }
  }
  const assertCurrent = () => {
    if (options.isCurrent && !options.isCurrent()) throw new Error("多区拼接任务已取消");
  };
  const layerIds: number[] = [];
  let groupId: number | null = null;
  let groupingStarted = false;
  let sourceSelection: SelectionBounds | null = null;
  let sourceSelectionCaptured = false;
  const errors: Array<{ phase: string; error: unknown }> = [];
  const restoreState = async (phase: string) => {
    if (sourceSelectionCaptured) {
      try {
        if (Number(photoshop.app.activeDocument?.id) !== sourceDocumentId) {
          await switchToDocumentUnlocked(sourceDocumentId);
        }
        await restoreSelectionUnlocked(sourceSelection);
      } catch (error) {
        errors.push({ phase: `${phase}选区`, error });
      }
    }
    if (restoreDocumentId && restoreDocumentId !== sourceDocumentId) {
      try {
        await switchToDocumentUnlocked(restoreDocumentId);
      } catch (error) {
        errors.push({ phase: `${phase}文档`, error });
      }
    }
  };
  try {
    assertCurrent();
    if (restoreDocumentId !== sourceDocumentId) await switchToDocumentUnlocked(sourceDocumentId);
    sourceSelection = photoshop.app.activeDocument?.selection?.bounds
      ? toBounds(photoshop.app.activeDocument.selection.bounds)
      : null;
    sourceSelectionCaptured = true;
    for (let index = 0; index < parts.length; index += 1) {
      assertCurrent();
      const previousLayerId = await activeLayerIdUnlocked().catch(() => null);
      try {
        const info = await placeImageIntoDocumentUnlocked(parts[index].dataUrl, index + 1, sourceDocumentId);
        const layerId = Number(info?.layerID ?? info?.layerId ?? info?.targetLayerID ?? info?.targetLayerId);
        if (!Number.isInteger(layerId) || layerId <= 0) throw new Error(`Photoshop 未返回区域 ${index + 1} 的图层 ID`);
        if (!(info?.smartObject || info?.smartObjectMore || Number(info?.layerKind) === 5)) {
          throw new Error(`区域 ${index + 1} 未以智能对象置入`);
        }
        layerIds.push(layerId);
        await resizeAtlasLayerUnlocked(layerId, info?.bounds ?? info?.boundsNoEffects, regions[index].bounds);
        await renameLayerUnlocked(layerId, `PXD 多区 ${index + 1}`);
      } catch (error) {
        const landedLayerId = await activeLayerIdUnlocked().catch(() => null);
        if (landedLayerId && landedLayerId !== previousLayerId && !layerIds.includes(landedLayerId)) {
          layerIds.push(landedLayerId);
        }
        throw error;
      }
      assertCurrent();
    }
    groupingStarted = true;
    groupId = await groupLayersUnlocked(layerIds, options.groupName ?? "PXD 多区拼接", { requireGroup: true });
    if (!groupId) throw new Error("Photoshop 未创建多区输出组");
    await moveActiveLayerToTopUnlocked(groupId);
    assertCurrent();
  } catch (error) {
    errors.push({ phase: "多区贴回", error });
  }

  await restoreState("恢复");
  if (!errors.length) {
    try {
      assertCurrent();
    } catch (error) {
      errors.push({ phase: "多区贴回", error });
    }
  }
  if (errors.length) {
    try {
      if (Number(photoshop.app.activeDocument?.id) !== sourceDocumentId) {
        await switchToDocumentUnlocked(sourceDocumentId);
      }
      const possibleGroupId = await activeLayerIdUnlocked().catch(() => null);
      const cleanupIds = groupId
        ? [groupId]
        : groupingStarted && possibleGroupId && !layerIds.includes(possibleGroupId)
          ? [possibleGroupId]
          : layerIds;
      await deleteLayersUnlocked(cleanupIds);
    } catch (error) {
      errors.push({ phase: "自动清理", error });
    }
    await restoreState("补偿后恢复");
    throw new AtlasPlacementError(errors);
  }
  return { layerIds, groupId: groupId as number };
}, options);
