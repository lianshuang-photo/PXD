/* Paste-back. Port of wheelchair host/ps-io.js:
   _writePlaceTempFile + _placeCoreInModal (placeEvent, transform, move)
   + createGroupAndMask (group / smart object). No hueSaturation / flip. */
var photoshop = require("photoshop");
var uxp = require("uxp");
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

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    return: returnImage,
    returnImage: returnImage,
    placeCoreInModal: placeCoreInModal,
    createGroupAndMask: createGroupAndMask
  };
}
var _g = (typeof window !== "undefined") ? window : (typeof globalThis !== "undefined" ? globalThis : this);
_g.ps = _g.ps || {};
_g.ps.return = returnImage;
