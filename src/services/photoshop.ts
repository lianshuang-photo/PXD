import { bridge } from "./uxpBridge";

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

const runJsxCode = async (jsx: string) => {
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
    await runJsxCode(jsx);
  } catch (error) {
    console.warn("resizeActiveLayerToBounds failed", error);
  }
};

const tryCreateMaskFromSelection = async (hasSelection: boolean) => {
  try {
    const photoshop = ensureModule(getPhotoshop, "Photoshop");
    await photoshop.core.executeAsModal(async () => {
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
    await runJsxCode(jsx);
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

export const groupLayers = async (layerIds: number[], groupName = DEFAULT_GROUP_NAME): Promise<number | null> => {
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
    await runJsxCode(jsx);
  } catch (error) {
    console.warn("groupLayers failed", error);
  }
  try {
    const info = await photoshop.core.executeAsModal(async () => {
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
    return Number.isFinite(id) && id > 0 ? id : null;
  } catch (error) {
    console.warn("groupLayers get info failed", error);
    return null;
  }
};

export const hasActiveSelection = async (): Promise<boolean> => {
  try {
    const photoshop = ensureModule(getPhotoshop, "Photoshop");
    const doc = photoshop.app.activeDocument;
    return Boolean(doc?.selection?.bounds);
  } catch {
    return false;
  }
};

export const getSelectionPixels = async (): Promise<SelectionPixels | null> => {
  try {
    const photoshop = ensureModule(getPhotoshop, "Photoshop");
    const doc = photoshop.app.activeDocument;
    if (!doc?.selection?.bounds) {
      return null;
    }
    const bounds = toBounds(doc.selection.bounds);
    return await photoshop.core.executeAsModal(
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

export const setSelectionBounds = async (bounds: SelectionBounds) => {
  const photoshop = ensureModule(getPhotoshop, "Photoshop");
  await photoshop.core.executeAsModal(async () => {
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

export const placeImageIntoSelection = async (
  dataUrl: string,
  index = 1,
  options?: { feather?: number }
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

  await photoshop.core.executeAsModal(
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

  const info = await photoshop.core.executeAsModal(async () => {
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
    await setSelectionBounds(cachedBounds).catch((error) => console.warn("restore selection failed", error));
    await resizeActiveLayerToBounds(cachedBounds);
    await setSelectionBounds(cachedBounds).catch((error) => console.warn("restore selection failed", error));
    await adjustSelectionForMask(cachedBounds, userFeather);
    await tryCreateMaskFromSelection(true);
    await setSelectionBounds(cachedBounds).catch((error) => console.warn("restore selection failed", error));
  } else {
    await tryCreateMaskFromSelection(false);
  }
  return info;
};

export const placeImageIntoDocument = async (dataUrl: string, index = 1, docId?: number) => {
  const photoshop = ensureModule(getPhotoshop, "Photoshop");
  const doc = photoshop.app.activeDocument;
  const base64 = dataUrl.includes(",") ? dataUrl.split(",").pop() ?? dataUrl : dataUrl;
  const token = await createTempTokenFromBase64(base64, `imgdoc-${index}.png`);

  await photoshop.core.executeAsModal(
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

  const info = await photoshop.core.executeAsModal(async () => {
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

export const moveActiveLayerToTop = async () => {
  const photoshop = ensureModule(getPhotoshop, "Photoshop");
  await photoshop.core.executeAsModal(async () => {
    await photoshop.app.batchPlay(
      [
        {
          _obj: "move",
          _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
          to: { _ref: "layer", _enum: "ordinal", _value: "front" }
        }
      ],
      {}
    );
  }, DEFAULT_MODAL_OPTIONS);
};

export const closeDocument = async (docId: number, activeDocId: number, newLayerId: number) => {
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
  await runJsxCode(jsx);
};

export const onBatchAddLayer = async (): Promise<[number, number, number] | null> => {
  const result = await runJsxCode(`
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

export const switchToDocument = async (docId: number) => {
  const photoshop = ensureModule(getPhotoshop, "Photoshop");
  await photoshop.core.executeAsModal(async () => {
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
