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

export interface ColorizeSource {
  dataUrl: string;
  documentId: number;
  documentWidth: number;
  documentHeight: number;
  selectionBounds: SelectionBounds | null;
  squareSize: number;
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
  options: PhotoshopOperationOptions = {},
  onLateSettlement?: (settlement:
    | { status: "fulfilled"; value: T }
    | { status: "rejected"; reason: unknown }
  ) => Promise<void> | void
): Promise<T> => runPSExclusive(operation, {
  taskId: options.taskId,
  timeoutMs: options.timeoutMs,
  onLateSettlement
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

const pixelValue = (value: unknown) => {
  if (typeof value === "number") return value;
  if (value && typeof value === "object") {
    const candidate = value as { value?: unknown; _value?: unknown; as?: (unit: string) => number };
    if (typeof candidate.as === "function") return Number(candidate.as("px"));
    return Number(candidate.value ?? candidate._value);
  }
  return Number(value);
};

const selectionBoundsEqual = (left: SelectionBounds, right: SelectionBounds) =>
  left.left === right.left &&
  left.top === right.top &&
  left.right === right.right &&
  left.bottom === right.bottom;

const colorizeErrorMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

const appendColorizeCleanupError = (
  error: unknown,
  label: string,
  cleanupError: unknown
) => new Error(
  `${colorizeErrorMessage(error, "智能调色贴回失败")}；${label}：${colorizeErrorMessage(cleanupError, "未知错误")}`
);

const activeColorizeLayerIdUnlocked = () => {
  const photoshop = ensureModule(getPhotoshop, "Photoshop");
  const layerId = Number(
    photoshop.app.activeDocument?.activeLayers?.[0]?.id ??
    photoshop.app.activeDocument?.activeLayer?.id
  );
  return Number.isInteger(layerId) && layerId > 0 ? layerId : 0;
};

const colorizeSelectionDescriptor = (bounds: SelectionBounds | null) => ({
  _obj: "set",
  _target: [{ _ref: "channel", _property: "selection" }],
  to: bounds
    ? selectionToRectangle(bounds)
    : { _enum: "ordinal", _value: "none" }
});

const setColorizeSelectionUnlocked = async (bounds: SelectionBounds | null) => {
  const photoshop = ensureModule(getPhotoshop, "Photoshop");
  await executeAsModalUnlocked(photoshop, async () => {
    await photoshop.app.batchPlay([colorizeSelectionDescriptor(bounds)], {});
  }, { commandName: "恢复 PXD 调色选区" });
};

const validateColorizeSourceUnlocked = async (source: ColorizeSource) => {
  const photoshop = ensureModule(getPhotoshop, "Photoshop");
  const document = photoshop.app.activeDocument;
  if (Number(document?.id) !== source.documentId) {
    throw new Error("等待智能调色期间活动文档已切换，请重新发起调色");
  }
  const width = Math.round(pixelValue(document?.width));
  const height = Math.round(pixelValue(document?.height));
  if (width !== source.documentWidth || height !== source.documentHeight) {
    throw new Error("等待智能调色期间画布尺寸已变化，请重新发起调色");
  }
};

const restoreColorizeContextUnlocked = async (source: ColorizeSource) => {
  const photoshop = ensureModule(getPhotoshop, "Photoshop");
  if (Number(photoshop.app.activeDocument?.id) !== source.documentId) {
    await switchToDocumentUnlocked(source.documentId);
  }
  const currentBounds = photoshop.app.activeDocument?.selection?.bounds
    ? toBounds(photoshop.app.activeDocument.selection.bounds)
    : null;
  const selectionMatches = source.selectionBounds
    ? currentBounds !== null && selectionBoundsEqual(currentBounds, source.selectionBounds)
    : currentBounds === null;
  if (!selectionMatches) {
    await setColorizeSelectionUnlocked(source.selectionBounds);
  }
};

const canvasSizeDescriptor = (width: number, height: number) => ({
  _obj: "canvasSize",
  width: { _unit: "pixelsUnit", _value: width },
  height: { _unit: "pixelsUnit", _value: height },
  horizontal: { _enum: "horizontalLocation", _value: "center" },
  vertical: { _enum: "verticalLocation", _value: "center" }
});

const expandCanvasToSquareUnlocked = async () => {
  const photoshop = ensureModule(getPhotoshop, "Photoshop");
  const doc = photoshop.app.activeDocument;
  const width = Math.round(pixelValue(doc.width));
  const height = Math.round(pixelValue(doc.height));
  const squareSize = Math.max(width, height);
  if (width !== height) {
    await executeAsModalUnlocked(photoshop, async () => {
      await photoshop.app.batchPlay([canvasSizeDescriptor(squareSize, squareSize)], {});
    }, { commandName: "扩展 PXD 调色画布" });
  }
  return { width, height, squareSize };
};

export const expandCanvasToSquare = (
  options: PhotoshopOperationOptions = {}
) => runTransaction(expandCanvasToSquareUnlocked, options);

const addBlackWhiteAdjustmentLayerUnlocked = async () => {
  const photoshop = ensureModule(getPhotoshop, "Photoshop");
  return await executeAsModalUnlocked(photoshop, async () => {
    const result = await photoshop.app.batchPlay([{
      _obj: "make",
      _target: [{ _ref: "adjustmentLayer" }],
      using: {
        _obj: "adjustmentLayer",
        name: "PXD 临时去色",
        type: { _obj: "blackAndWhite" }
      }
    }], {});
    const directId = Number(result?.[0]?.layerID ?? result?.[0]?.layerId);
    if (Number.isFinite(directId) && directId > 0) return directId;
    const info = await photoshop.app.batchPlay([{
      _obj: "get",
      _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }]
    }], { synchronousExecution: true });
    const layerId = Number(info?.[0]?.layerID ?? info?.[0]?.layerId);
    if (!Number.isFinite(layerId) || layerId <= 0) throw new Error("Photoshop 未返回黑白调整层 ID");
    return layerId;
  }, { commandName: "添加 PXD 黑白调整层" });
};

export const addBlackWhiteAdjustmentLayer = (
  options: PhotoshopOperationOptions = {}
) => runTransaction(addBlackWhiteAdjustmentLayerUnlocked, options);

const deleteLayerUnlocked = async (layerId: number) => {
  const photoshop = ensureModule(getPhotoshop, "Photoshop");
  await executeAsModalUnlocked(photoshop, async () => {
    await photoshop.app.batchPlay([{
      _obj: "delete",
      _target: [{ _ref: "layer", _id: layerId }]
    }], {});
  }, { commandName: "删除 PXD 临时图层" });
};

export const deleteLayer = (
  layerId: number,
  options: PhotoshopOperationOptions = {}
) => runTransaction(() => deleteLayerUnlocked(layerId), options);

const setLayerBlendModeUnlocked = async (layerId: number, mode: "color") => {
  const photoshop = ensureModule(getPhotoshop, "Photoshop");
  await executeAsModalUnlocked(photoshop, async () => {
    await photoshop.app.batchPlay([{
      _obj: "set",
      _target: [{ _ref: "layer", _id: layerId }],
      to: {
        _obj: "layer",
        name: "AI 智能调色",
        mode: { _enum: "blendMode", _value: mode }
      }
    }], {});
  }, { commandName: "设置 PXD 调色混合模式" });
};

export const setLayerBlendMode = (
  layerId: number,
  mode: "color" = "color",
  options: PhotoshopOperationOptions = {}
) => runTransaction(() => setLayerBlendModeUnlocked(layerId, mode), options);

const captureDocumentPixelsUnlocked = async (
  documentId: number,
  width: number,
  height: number
) => {
  const photoshop = ensureModule(getPhotoshop, "Photoshop");
  return await executeAsModalUnlocked(photoshop, async () => {
    const pixels = await photoshop.imaging.getPixels({
      documentID: documentId,
      sourceBounds: { left: 0, top: 0, right: width, bottom: height },
      applyAlpha: true,
      componentSize: 8,
      colorProfile: "sRGB IEC61966-2.1"
    });
    try {
      return await photoshop.imaging.encodeImageData({ imageData: pixels.imageData, base64: true });
    } finally {
      pixels.imageData.dispose?.();
    }
  }, { commandName: "截取 PXD 去色图" });
};

const prepareColorizeSourceUnlocked = async (): Promise<ColorizeSource> => {
  const photoshop = ensureModule(getPhotoshop, "Photoshop");
  const originalDocument = photoshop.app.activeDocument;
  const documentId = Number(originalDocument?.id);
  const documentWidth = Math.round(pixelValue(originalDocument?.width));
  const documentHeight = Math.round(pixelValue(originalDocument?.height));
  const hasSelection = await hasActiveSelectionUnlocked();
  const selection = hasSelection ? await getSelectionPixelsUnlocked() : null;
  if (hasSelection && !selection) throw new Error("无法读取当前 Photoshop 选区");
  const sourceDataUrl = selection?.dataUrl ?? `data:image/png;base64,${await captureDocumentPixelsUnlocked(
    documentId,
    documentWidth,
    documentHeight
  )}`;
  const sourceWidth = selection?.width ?? documentWidth;
  const sourceHeight = selection?.height ?? documentHeight;
  let temporaryDocument: GeneratedDocumentSession | null = null;
  let adjustmentLayerId: number | null = null;
  try {
    temporaryDocument = await createGeneratedDocumentUnlocked(sourceWidth, sourceHeight, "PXD 调色预处理");
    await placeImageIntoDocumentUnlocked(sourceDataUrl, 1, temporaryDocument.documentId);
    const { squareSize } = await expandCanvasToSquareUnlocked();
    adjustmentLayerId = await addBlackWhiteAdjustmentLayerUnlocked();
    const encoded = await captureDocumentPixelsUnlocked(temporaryDocument.documentId, squareSize, squareSize);
    await deleteLayerUnlocked(adjustmentLayerId);
    adjustmentLayerId = null;
    return {
      dataUrl: `data:image/png;base64,${encoded}`,
      documentId,
      documentWidth,
      documentHeight,
      selectionBounds: selection?.selectionBounds ?? null,
      squareSize
    };
  } finally {
    let cleanupError: unknown;
    if (adjustmentLayerId) {
      try {
        await deleteLayerUnlocked(adjustmentLayerId);
      } catch (error) {
        cleanupError = error;
      }
    }
    if (temporaryDocument) {
      try {
        await closeGeneratedDocumentUnlocked(temporaryDocument.documentId, documentId);
      } catch (error) {
        cleanupError ??= error;
      }
    }
    try {
      if (Number(photoshop.app.activeDocument?.id) !== documentId) {
        await switchToDocumentUnlocked(documentId);
      }
    } catch (error) {
      cleanupError ??= error;
    }
    if (cleanupError) throw cleanupError;
  }
};

export const prepareColorizeSource = (
  options: PhotoshopOperationOptions = {}
): Promise<ColorizeSource> => runTransaction(prepareColorizeSourceUnlocked, options);

export const validateColorizeSource = (
  source: ColorizeSource,
  options: PhotoshopOperationOptions = {}
): Promise<void> => runTransaction(() => validateColorizeSourceUnlocked(source), options);

const placeColorizedResultUnlocked = async (
  source: ColorizeSource,
  dataUrl: string,
  isCurrent: () => boolean
) => {
  const photoshop = ensureModule(getPhotoshop, "Photoshop");
  await validateColorizeSourceUnlocked(source);
  const resultBase64 = dataUrl.includes(",") ? dataUrl.split(",").pop() ?? dataUrl : dataUrl;
  const token = await createTempTokenFromBase64(resultBase64, "pxd-colorized.png");
  const previousLayerId = activeColorizeLayerIdUnlocked();
  let layerId = 0;
  const squareCanvas = Math.max(source.documentWidth, source.documentHeight);
  const offsetX = (squareCanvas - source.documentWidth) / 2;
  const offsetY = (squareCanvas - source.documentHeight) / 2;
  const sourceRegion = source.selectionBounds ?? {
    left: 0,
    top: 0,
    right: source.documentWidth,
    bottom: source.documentHeight
  };
  const shiftedSelection = {
    left: sourceRegion.left + offsetX,
    top: sourceRegion.top + offsetY,
    right: sourceRegion.right + offsetX,
    bottom: sourceRegion.bottom + offsetY
  };
  const selectionWidth = shiftedSelection.right - shiftedSelection.left;
  const selectionHeight = shiftedSelection.bottom - shiftedSelection.top;
  const targetSize = Math.max(selectionWidth, selectionHeight);
  try {
    await photoshop.core.executeAsModal(async (executionContext: any) => {
      const suspension = await executionContext.hostControl.suspendHistory({
        documentID: source.documentId,
        name: "AI 智能调色"
      });
      let operationError: unknown;
      try {
        if (!isCurrent()) throw new Error("COLORIZE_CANCELLED");
        if (source.documentWidth !== source.documentHeight) {
          await photoshop.app.batchPlay([canvasSizeDescriptor(squareCanvas, squareCanvas)], {});
        }
        const placeResult = await photoshop.app.batchPlay([{
          ID: source.documentId,
          _obj: "placeEvent",
          freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSAverage" },
          null: { _kind: "local", _path: token },
          offset: {
            _obj: "offset",
            horizontal: { _unit: "pixelsUnit", _value: 0 },
            vertical: { _unit: "pixelsUnit", _value: 0 }
          }
        }], {});
        const placedLayerId = Number(placeResult?.[0]?.layerID ?? placeResult?.[0]?.layerId);
        if (Number.isInteger(placedLayerId) && placedLayerId > 0) layerId = placedLayerId;
        const activeLayerId = activeColorizeLayerIdUnlocked();
        if (activeLayerId && activeLayerId !== previousLayerId) layerId = activeLayerId;

        const info = await photoshop.app.batchPlay([{
          _obj: "get",
          _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }]
        }], { synchronousExecution: true });
        const layer = info[0] ?? {};
        const reportedLayerId = Number(layer.layerID ?? layer.layerId);
        if (Number.isInteger(reportedLayerId) && reportedLayerId > 0 && reportedLayerId !== previousLayerId) {
          layerId = reportedLayerId;
        }
        if (!layerId || layerId === previousLayerId) {
          throw new Error("Photoshop 未返回智能调色图层 ID");
        }
        const bounds = layer.bounds ?? {};
        const left = pixelValue(bounds.left);
        const top = pixelValue(bounds.top);
        const right = pixelValue(bounds.right);
        const bottom = pixelValue(bounds.bottom);
        if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top) {
          throw new Error("Photoshop 未返回有效的智能调色图层范围");
        }
        const layerWidth = right - left;
        const layerHeight = bottom - top;
        const targetCenterX = (shiftedSelection.left + shiftedSelection.right) / 2;
        const targetCenterY = (shiftedSelection.top + shiftedSelection.bottom) / 2;
        await photoshop.app.batchPlay([{
          _obj: "transform",
          _target: [{ _ref: "layer", _id: layerId }],
          freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSAverage" },
          offset: {
            _obj: "offset",
            horizontal: { _unit: "pixelsUnit", _value: targetCenterX - (left + right) / 2 },
            vertical: { _unit: "pixelsUnit", _value: targetCenterY - (top + bottom) / 2 }
          },
          width: { _unit: "percentUnit", _value: targetSize / layerWidth * 100 },
          height: { _unit: "percentUnit", _value: targetSize / layerHeight * 100 }
        }, {
          _obj: "set",
          _target: [{ _ref: "channel", _property: "selection" }],
          to: selectionToRectangle(shiftedSelection)
        }, {
          _obj: "make",
          new: { _class: "channel" },
          at: { _ref: "channel", _enum: "channel", _value: "mask" },
          using: { _enum: "userMaskEnabled", _value: "revealSelection" }
        }, {
          _obj: "set",
          _target: [{ _ref: "layer", _id: layerId }],
          to: {
            _obj: "layer",
            name: "AI 智能调色",
            mode: { _enum: "blendMode", _value: "color" }
          }
        }], {});
        if (!isCurrent()) throw new Error("COLORIZE_CANCELLED");
        if (source.documentWidth !== source.documentHeight) {
          await photoshop.app.batchPlay([canvasSizeDescriptor(source.documentWidth, source.documentHeight)], {});
        }
        await photoshop.app.batchPlay([colorizeSelectionDescriptor(source.selectionBounds)], {});
      } catch (error) {
        operationError = error;
        if (!layerId) {
          const activeLayerId = activeColorizeLayerIdUnlocked();
          if (activeLayerId && activeLayerId !== previousLayerId) layerId = activeLayerId;
        }
        if (layerId) {
          try {
            await photoshop.app.batchPlay([{
              _obj: "delete",
              _target: [{ _ref: "layer", _id: layerId }]
            }], {});
            layerId = 0;
          } catch (caught) {
            operationError = appendColorizeCleanupError(operationError, "自动清理失败", caught);
          }
        }
        if (source.documentWidth !== source.documentHeight) {
          await photoshop.app.batchPlay([canvasSizeDescriptor(source.documentWidth, source.documentHeight)], {})
            .catch((caught) => {
              operationError = appendColorizeCleanupError(operationError, "画布恢复失败", caught);
            });
        }
        await photoshop.app.batchPlay([colorizeSelectionDescriptor(source.selectionBounds)], {}).catch((caught) => {
          operationError = appendColorizeCleanupError(operationError, "选区恢复失败", caught);
        });
      } finally {
        try {
          await executionContext.hostControl.resumeHistory(suspension);
        } catch (resumeError) {
          operationError = operationError
            ? appendColorizeCleanupError(operationError, "历史记录恢复失败", resumeError)
            : resumeError;
        }
      }
      if (operationError) throw operationError;
    }, { commandName: "AI 智能调色贴回" });
  } catch (error) {
    let cleanupError: unknown;
    if (!layerId) {
      const activeLayerId = activeColorizeLayerIdUnlocked();
      if (activeLayerId && activeLayerId !== previousLayerId) layerId = activeLayerId;
    }
    if (layerId) {
      try {
        await deleteLayerUnlocked(layerId);
        layerId = 0;
      } catch (caught) {
        cleanupError = caught;
      }
    }
    try {
      if (Number(photoshop.app.activeDocument?.id) !== source.documentId) {
        await switchToDocumentUnlocked(source.documentId);
      }
      if (source.documentWidth !== source.documentHeight) {
        const activeDocument = photoshop.app.activeDocument;
        const width = Math.round(pixelValue(activeDocument?.width));
        const height = Math.round(pixelValue(activeDocument?.height));
        if (width !== source.documentWidth || height !== source.documentHeight) {
          await executeAsModalUnlocked(photoshop, async () => {
            await photoshop.app.batchPlay([canvasSizeDescriptor(source.documentWidth, source.documentHeight)], {});
          }, { commandName: "恢复 PXD 调色画布" });
        }
      }
      await restoreColorizeContextUnlocked(source);
    } catch (caught) {
      cleanupError = cleanupError
        ? appendColorizeCleanupError(cleanupError, "上下文恢复失败", caught)
        : caught;
    }
    if (cleanupError) {
      const combined = appendColorizeCleanupError(error, "自动清理失败", cleanupError) as Error & {
        placedLayerId?: number;
      };
      if (layerId > 0) combined.placedLayerId = layerId;
      throw combined;
    }
    throw error;
  }
  return { layerId };
};

const cleanupLateColorizedResultUnlocked = async (
  source: ColorizeSource,
  layerId: number
) => {
  const photoshop = ensureModule(getPhotoshop, "Photoshop");
  if (Number(photoshop.app.activeDocument?.id) !== source.documentId) {
    await switchToDocumentUnlocked(source.documentId);
  }
  if (layerId > 0) await deleteLayerUnlocked(layerId);
  const activeDocument = photoshop.app.activeDocument;
  const width = Math.round(pixelValue(activeDocument?.width));
  const height = Math.round(pixelValue(activeDocument?.height));
  if (width !== source.documentWidth || height !== source.documentHeight) {
    await executeAsModalUnlocked(photoshop, async () => {
      await photoshop.app.batchPlay([canvasSizeDescriptor(source.documentWidth, source.documentHeight)], {});
    }, { commandName: "清理超时 PXD 调色画布" });
  }
  await restoreColorizeContextUnlocked(source);
};

export const placeColorizedResult = (
  source: ColorizeSource,
  dataUrl: string,
  isCurrent: () => boolean,
  options: PhotoshopOperationOptions = {}
) => runTransaction(
  () => placeColorizedResultUnlocked(source, dataUrl, isCurrent),
  options,
  async (settlement) => {
    const layerId = settlement.status === "fulfilled"
      ? settlement.value.layerId
      : Number(
          settlement.reason && typeof settlement.reason === "object"
            ? (settlement.reason as { placedLayerId?: unknown }).placedLayerId
            : 0
        );
    await cleanupLateColorizedResultUnlocked(source, Number.isInteger(layerId) ? layerId : 0);
  }
);

export const restoreColorizeContext = (
  source: ColorizeSource,
  options: PhotoshopOperationOptions = {}
) => runTransaction(() => restoreColorizeContextUnlocked(source), options);
