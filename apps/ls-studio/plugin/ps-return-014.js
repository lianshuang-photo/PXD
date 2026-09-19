/* Paste-back. Port of wheelchair host/ps-io.js:
   _writePlaceTempFile + _placeCoreInModal (placeEvent, transform, move)
   + createGroupAndMask (group / smart object). No hueSaturation / flip. */
var photoshop = null;
var uxp = null;
var encode = (typeof require === "function" ? (function () {
  try { return require("./ps-encode-014.js"); } catch (_) { return null; }
})() : null) || (typeof window !== "undefined" ? window.psEncode : null);
if (!encode) throw new Error("ps-encode 未加载");

function num(v, fallback) {
  if (v == null) return fallback;
  if (typeof v === "number") return v;
  if (typeof v === "object" && v._value !== undefined) return v._value;
  var n = Number(v);
  return isNaN(n) ? fallback : n;
}

async function writePlaceTempFile(base64Str) {
  uxp = uxp || require("uxp");
  var storage = uxp.storage;
  var fs = storage.localFileSystem;
  var folder;
  try {
    folder = await fs.getTemporaryFolder();
  } catch (_) {
    folder = await fs.getDataFolder();
  }
  var ts = Date.now() + "_" + Math.random().toString(36).substr(2, 4);
  var rawFile = await folder.createFile("pxdls_place_" + ts + ".png", { overwrite: true });
  var rawBytes = encode.base64ToArrayBuffer(base64Str);
  await rawFile.write(rawBytes, { format: storage.formats.binary });
  return rawFile;
}

async function placeCoreInModal(rawFile, targetDocId, targetSelection, layerType) {
  photoshop = photoshop || require("photoshop");
  uxp = uxp || require("uxp");
  var app = photoshop.app;
  var fs = uxp.storage.localFileSystem;
  var targetDoc = app.documents.find(function (d) { return d.id === targetDocId; });
  if (!targetDoc) throw new Error("找不到目标文档");

  await app.batchPlay([{ _obj: "select", _target: [{ _ref: "document", _id: targetDocId }] }], {});
  await app.batchPlay([{
    _obj: "select",
    _target: [{ _ref: "layer", _enum: "ordinal", _value: "front" }],
    makeVisible: false
  }], {});

  var placeToken = await fs.createSessionToken(rawFile);
  await app.batchPlay([{
    _obj: "placeEvent",
    null: { _path: placeToken, _kind: "local" },
    freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSAverage" },
    offset: { _obj: "offset", horizontal: { _unit: "pixelsUnit", _value: 0 }, vertical: { _unit: "pixelsUnit", _value: 0 } }
  }], {});

  if (targetSelection) {
    var boundsResult = await app.batchPlay([{
      _obj: "get",
      _target: [{ _property: "boundsNoEffects" }, { _ref: "layer", _enum: "ordinal", _value: "targetEnum" }]
    }], {});
    var curLeft = 0, curTop = 0, curWidth = 0, curHeight = 0;
    if (boundsResult && boundsResult[0] && boundsResult[0].boundsNoEffects) {
      var b = boundsResult[0].boundsNoEffects;
      curLeft = num(b.left, 0);
      curTop = num(b.top, 0);
      curWidth = num(b.right, 0) - curLeft;
      curHeight = num(b.bottom, 0) - curTop;
    }
    if (curWidth <= 0 || curHeight <= 0) {
      var boundsResult2 = await app.batchPlay([{
        _obj: "get",
        _target: [{ _property: "bounds" }, { _ref: "layer", _enum: "ordinal", _value: "targetEnum" }]
      }], {});
      if (boundsResult2 && boundsResult2[0] && boundsResult2[0].bounds) {
        var b2 = boundsResult2[0].bounds;
        curLeft = num(b2.left, 0);
        curTop = num(b2.top, 0);
        curWidth = num(b2.right, 0) - curLeft;
        curHeight = num(b2.bottom, 0) - curTop;
      }
    }

    if (curWidth > 0 && curHeight > 0) {
      var scaleX = (targetSelection.width / curWidth) * 100;
      var scaleY = (targetSelection.height / curHeight) * 100;
      if (Math.abs(scaleX - 100) > 0.01 || Math.abs(scaleY - 100) > 0.01) {
        await app.batchPlay([{
          _obj: "transform",
          _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
          freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSCorner0" },
          width: { _unit: "percentUnit", _value: scaleX },
          height: { _unit: "percentUnit", _value: scaleY },
          interfaceIconFrameDimmed: { _enum: "interpolationType", _value: "bicubicAutomatic" }
        }], {});
      }
    }

    var newBoundsResult = await app.batchPlay([{
      _obj: "get",
      _target: [{ _property: "bounds" }, { _ref: "layer", _enum: "ordinal", _value: "targetEnum" }]
    }], {});
    var newLeft = curLeft, newTop = curTop;
    if (newBoundsResult && newBoundsResult[0] && newBoundsResult[0].bounds) {
      var nb = newBoundsResult[0].bounds;
      newLeft = num(nb.left, curLeft);
      newTop = num(nb.top, curTop);
    }
    var moveX = targetSelection.left - newLeft;
    var moveY = targetSelection.top - newTop;
    if (Math.abs(moveX) > 0.5 || Math.abs(moveY) > 0.5) {
      await app.batchPlay([{
        _obj: "move",
        _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
        to: {
          _obj: "offset",
          horizontal: { _unit: "pixelsUnit", _value: Math.round(moveX) },
          vertical: { _unit: "pixelsUnit", _value: Math.round(moveY) }
        }
      }], {});
    }
  }

  if (layerType !== "smartObject") {
    await app.batchPlay([{
      _obj: "rasterizeLayer",
      _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }]
    }], {});
  }

  return app.activeDocument.activeLayers[0].id;
}

async function createGroupAndMask(layerIds, groupNamePrefix) {
  photoshop = photoshop || require("photoshop");
  var app = photoshop.app;
  var groupName = (groupNamePrefix || "PXD/LS") + " 生成组";
  var selectTargets = layerIds.map(function (id) { return { _ref: "layer", _id: id }; });
  await app.batchPlay([{
    _obj: "select",
    _target: selectTargets,
    selectionModifier: { _enum: "selectionModifierType", _value: "replaceSelection" },
    makeVisible: false
  }], {});
  await app.batchPlay([{
    _obj: "make",
    _target: [{ _ref: "layerSection" }],
    from: { _ref: "layer", _enum: "ordinal", _value: "targetEnum" },
    name: groupName
  }], {});
  try {
    await app.batchPlay([{
      _obj: "set",
      _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
      to: { _obj: "layer", name: groupName }
    }], {});
  } catch (_) {}
  await app.batchPlay([{
    _obj: "set",
    _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
    to: { _obj: "layer", color: { _enum: "color", _value: "yellowColor" } }
  }], {});
  await app.batchPlay([{
    _obj: "move",
    _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
    to: { _ref: "layer", _enum: "ordinal", _value: "front" }
  }], {});
  await app.batchPlay([{
    _obj: "make",
    new: { _class: "channel" },
    at: { _ref: "channel", _enum: "channel", _value: "mask" },
    using: { _enum: "userMaskEnabled", _value: "revealAll" }
  }], {});
  await app.batchPlay([{
    _obj: "select",
    _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
    makeVisible: false
  }], {});
  await app.batchPlay([{
    _obj: "set",
    _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
    to: { _obj: "layer", layerSectionExpanded: true }
  }], {});
  try {
    return app.activeDocument.activeLayers[0].id;
  } catch (_) {
    return null;
  }
}

/**
 * returnImage({ base64, selection, docId, layerType, group, groupName })
 * layerType: "smartObject" (default, keep placeEvent SO) | "raster" (new pixel layer)
 * returns { layerId, groupId }
 */
async function returnImage(opts, selection) {
  photoshop = photoshop || require("photoshop");
  if (typeof opts === "string") {
    opts = { base64: opts, selection: selection };
  }
  opts = opts || {};
  var base64Str = opts.base64;
  if (!base64Str) throw new Error("return 需要 base64");
  var app = photoshop.app;
  var core = photoshop.core;
  var doc = app.activeDocument;
  if (!doc) throw new Error("没有打开的文档");
  var targetDocId = opts.docId != null ? opts.docId : doc.id;
  var layerType = opts.layerType || "smartObject";
  var doGroup = opts.group !== false;
  var groupName = opts.groupName || "PXD/LS";

  var rawFile = await writePlaceTempFile(base64Str);
  var createdLayerId = null;
  var groupId = null;
  try {
    await core.executeAsModal(async function () {
      createdLayerId = await placeCoreInModal(rawFile, targetDocId, opts.selection, layerType);
      if (doGroup && createdLayerId != null) {
        groupId = await createGroupAndMask([createdLayerId], groupName);
      }
    }, { commandName: "PXD/LS return" });
  } finally {
    try { await rawFile.delete(); } catch (_) {}
  }
  return { applied: true, layerId: createdLayerId, groupId: groupId, selection: opts.selection };
}

/** Safe native placement. The owner supplies history transactions and capture provenance.
 * File headers and native smart-object dimensions are checked independently. Using
 * the full smart-object quad (not opaque layer bounds) preserves transparent margins.
 */
function createProductionReturn(ps, codec, options) {
  options = options || {};
  var pixelTools = options.pixelTools || require("./ps-pixels-014.js");
  function reject(code, message) { var error = new Error(message); error.code = code; throw error; }
  function value(v) { return typeof v === "number" ? v : Number(v && (v._value != null ? v._value : v.value != null ? v.value : v)); }
  function target(docId, layerId) { return [{ _ref: "layer", _id: layerId }, { _ref: "document", _id: docId }]; }
  function layerIds(doc) { var found = []; function walk(layers) { Array.from(layers).forEach(function (layer) { found.push(layer.id); if (layer.layers && layer.layers.length) walk(layer.layers); }); } walk(doc.layers); return found; }
  async function checked(commands) { return options.batchPlay(commands); }
  function validateImage(image) {
    if (!image || typeof image.base64 !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.base64) || image.base64.length > Math.ceil(pixelTools.MAX_BYTES / 3) * 4) reject("INVALID_IMAGE", "生成图像不是有效且不超过 32 MiB 的 base64");
    var bytes;
    try { bytes = new Uint8Array(codec.base64ToArrayBuffer(image.base64)); } catch (_) { reject("INVALID_IMAGE", "无法解码生成图像"); }
    var info = pixelTools.inspectImage(bytes, image.mimeType);
    if (info.width !== image.width || info.height !== image.height) reject("IMAGE_DIMENSION_MISMATCH", "生成图像声明尺寸与文件实际尺寸不一致");
    return bytes;
  }
  async function prepare(args, capture) {
    if (args.settings && args.settings.groupResults) reject("HOST_UNSUPPORTED", "此生产版本尚不支持自动编组；请关闭编组选项");
    if (args.settings && args.settings.returnType && args.settings.returnType !== "new-layer") reject("HOST_UNSUPPORTED", "生产回写只支持新建图层");
    if (!options.batchPlay) reject("HOST_UNSUPPORTED", "缺少受控 Photoshop 命令执行器");
    if (capture.maskPixels && (!ps.imaging || !ps.imaging.createImageDataFromBuffer || !ps.imaging.putLayerMask)) reject("HOST_UNSUPPORTED", "此 Photoshop 版本不能写入真实图层蒙版");
    var bytes = validateImage(args.image), storage = (options.uxp || require("uxp")).storage, folder = await storage.localFileSystem.getTemporaryFolder();
    var file = await folder.createFile("ls-studio-result-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2) + (args.image.mimeType === "image/png" ? ".png" : ".jpg"), { overwrite: false });
    try {
      await file.write(bytes.buffer, { format: storage.formats.binary });
      var token = await storage.localFileSystem.createSessionToken(file);
      return { file: file, token: token };
    } catch (error) { try { await file.delete(); } catch (_) {} throw error; }
  }
  async function quad(doc, layerId, image) {
    var rows = await checked([{ _obj: "get", _target: [{ _property: "smartObjectMore" }].concat(target(doc.id, layerId)), _options: { dialogOptions: "dontDisplay" } }]);
    var info = rows[0].smartObjectMore, size = info && info.size, points = info && info.transform;
    if (!size || value(size.width) !== image.width || value(size.height) !== image.height) reject("IMAGE_DIMENSION_MISMATCH", "Photoshop 解码尺寸与生成图像不一致，已取消回写");
    if (!Array.isArray(points) || points.length !== 8 || points.some(function (v) { return !Number.isFinite(v); }) || Math.abs(points[1] - points[3]) > 0.01 || Math.abs(points[2] - points[4]) > 0.01 || Math.abs(points[5] - points[7]) > 0.01 || Math.abs(points[0] - points[6]) > 0.01 || points[2] <= points[0] || points[5] <= points[1]) reject("HOST_UNSUPPORTED", "Photoshop 放置结果的坐标映射无法可靠读取");
    return { left: points[0], top: points[1], right: points[2], bottom: points[5] };
  }
  async function placeInModal(doc, args, capture, prepared) {
    var before = layerIds(doc);
    await checked([{ _obj: "placeEvent", null: { _path: prepared.token, _kind: "local" }, freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSAverage" }, offset: { _obj: "offset", horizontal: { _unit: "pixelsUnit", _value: 0 }, vertical: { _unit: "pixelsUnit", _value: 0 } }, _options: { dialogOptions: "dontDisplay" } }]);
    var added = layerIds(doc).filter(function (id) { return before.indexOf(id) < 0; });
    var active = Array.from(doc.activeLayers || []);
    if (added.length !== 1 || active.length !== 1 || active[0].id !== added[0]) reject("HOST_EXECUTION_FAILED", "Photoshop 未创建唯一的新图层");
    var layerId = added[0], desired = args.transform.sourceBounds, current = await quad(doc, layerId, args.image);
    var sx = (desired.right - desired.left) / (current.right - current.left), sy = (desired.bottom - desired.top) / (current.bottom - current.top);
    if (Math.abs(sx - 1) > 0.000001 || Math.abs(sy - 1) > 0.000001) {
      await checked([{ _obj: "transform", _target: target(doc.id, layerId), freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSCorner0" }, width: { _unit: "percentUnit", _value: sx * 100 }, height: { _unit: "percentUnit", _value: sy * 100 }, interfaceIconFrameDimmed: { _enum: "interpolationType", _value: "bicubicAutomatic" }, _options: { dialogOptions: "dontDisplay" } }]);
      current = await quad(doc, layerId, args.image);
    }
    var dx = desired.left - current.left, dy = desired.top - current.top;
    if (Math.abs(dx) > 0.001 || Math.abs(dy) > 0.001) await checked([{ _obj: "move", _target: target(doc.id, layerId), to: { _obj: "offset", horizontal: { _unit: "pixelsUnit", _value: dx }, vertical: { _unit: "pixelsUnit", _value: dy } }, _options: { dialogOptions: "dontDisplay" } }]);
    current = await quad(doc, layerId, args.image);
    if (["left", "top", "right", "bottom"].some(function (key) { return Math.abs(current[key] - desired[key]) > 0.05; })) reject("HOST_EXECUTION_FAILED", "Photoshop 回写范围未匹配原始坐标");
    await checked([{ _obj: "rasterizeLayer", _target: target(doc.id, layerId), _options: { dialogOptions: "dontDisplay" } }]);
    if (capture.maskPixels) {
      // This is the captured coverage, including zero-valued holes and feathering.
      // No current-selection dependency and no bounding-box fallback.
      var maskData = await ps.imaging.createImageDataFromBuffer(new Uint8Array(capture.maskPixels), { width: args.transform.inputWidth, height: args.transform.inputHeight, components: 1, chunky: true, colorSpace: "Grayscale" });
      try {
        await checked([{ _obj: "make", new: { _class: "channel" }, at: { _ref: "channel", _enum: "channel", _value: "mask" }, using: { _enum: "userMaskEnabled", _value: "revealAll" }, _options: { dialogOptions: "dontDisplay" } }]);
        var response = await ps.imaging.putLayerMask({ documentID: doc.id, layerID: layerId, imageData: maskData, replace: true, targetBounds: { left: desired.left, top: desired.top }, commandName: "LS Studio · 写入真实选区蒙版" });
        if (response && (response._obj === "error" || typeof response.result === "number" && response.result < 0)) reject("HOST_EXECUTION_FAILED", "Photoshop 未能写入选区蒙版");
      } finally { if (maskData && maskData.dispose) maskData.dispose(); }
    }
    return { createdLayerIds: [layerId], modifiedLayers: [], transform: args.transform, placement: { imageWidth: args.image.width, imageHeight: args.image.height, scaleX: (desired.right - desired.left) / args.image.width, scaleY: (desired.bottom - desired.top) / args.image.height, masked: !!capture.maskPixels, returnType: "new-layer" } };
  }
  return { prepare: prepare, placeInModal: placeInModal, validateImage: validateImage, cleanup: async function (prepared) { if (prepared && prepared.file) await prepared.file.delete(); } };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    return: returnImage,
    returnImage: returnImage,
    placeCoreInModal: placeCoreInModal,
    createGroupAndMask: createGroupAndMask,
    createProductionReturn: createProductionReturn
  };
}
var _g = (typeof window !== "undefined") ? window : (typeof globalThis !== "undefined" ? globalThis : this);
_g.ps = _g.ps || {};
_g.ps.return = returnImage;
