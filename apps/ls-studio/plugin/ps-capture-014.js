/* Selection-bounded capture. Port of wheelchair host/ps-io.js getSelectionAndImage
   (selection probe + imaging.getPixels on sourceBounds). No hue-shift, no full-canvas default. */
// Loaded only by the legacy entry point; production factories receive an explicit host.
var photoshop = null;
var encode = (typeof require === "function" ? (function () {
  try { return require("./ps-encode-014.js"); } catch (_) { return null; }
})() : null) || (typeof window !== "undefined" ? window.psEncode : null);
if (!encode) throw new Error("ps-encode 未加载");

var MAX_EDGE = 2048;

function log(msg) {
  try { console.log("[ps.capture] " + msg); } catch (_) {}
}

function num(v) {
  if (v == null) return undefined;
  if (typeof v === "number") return v;
  if (typeof v === "object" && v._value !== undefined) return v._value;
  return Number(v);
}

function rectFromRaw(left, top, right, bottom) {
  left = Math.round(left);
  top = Math.round(top);
  right = Math.round(right);
  bottom = Math.round(bottom);
  var width = right - left;
  var height = bottom - top;
  if (!(width > 0) || !(height > 0)) return null;
  return { left: left, top: top, right: right, bottom: bottom, width: width, height: height };
}

async function detectSelection(app, doc) {
  var selBounds = null;
  var lastErr = null;
  var probeCompleted = false;
  var retries = 2;

  while (retries >= 0 && !selBounds) {
    try {
      var b = doc.selection && doc.selection.bounds;
      probeCompleted = true;
      if (b && typeof b.left === "number" && typeof b.right === "number"
          && !isNaN(b.left) && !isNaN(b.right) && (b.right - b.left) > 0) {
        selBounds = rectFromRaw(b.left, b.top, b.right, b.bottom);
        if (selBounds) break;
      }
    } catch (e1) { lastErr = e1; }

    if (!selBounds) {
      try {
        var bpResult = await app.batchPlay([{
          _obj: "get",
          _target: [{ _property: "selection" }, { _ref: "document", _enum: "ordinal", _value: "targetEnum" }]
        }], {});
        probeCompleted = true;
        if (bpResult && bpResult[0] && bpResult[0].selection) {
          var sel = bpResult[0].selection;
          var sLeft, sTop, sRight, sBottom;
          if (sel.left !== undefined) {
            sLeft = num(sel.left); sTop = num(sel.top);
            sRight = num(sel.right); sBottom = num(sel.bottom);
          } else if (sel._obj === "rectangle") {
            sLeft = num(sel.left); sTop = num(sel.top);
            sRight = num(sel.right); sBottom = num(sel.bottom);
          }
          if (sLeft !== undefined && sRight !== undefined) {
            selBounds = rectFromRaw(sLeft, sTop, sRight, sBottom);
            if (selBounds) break;
          }
        }
      } catch (e2) { if (!lastErr) lastErr = e2; }
    }

    if (!selBounds) {
      try {
        var chResult = await app.batchPlay([{
          _obj: "get",
          _target: [{ _property: "bounds" }, { _ref: "channel", _enum: "channel", _value: "selection" }]
        }], {});
        probeCompleted = true;
        if (chResult && chResult[0] && chResult[0].bounds) {
          var cb = chResult[0].bounds;
          selBounds = rectFromRaw(num(cb.left), num(cb.top), num(cb.right), num(cb.bottom));
          if (selBounds) break;
        }
      } catch (e3) { if (!lastErr) lastErr = e3; }
    }

    if (retries > 0) {
      await new Promise(function (r) { setTimeout(r, 200); });
    }
    retries--;
  }

  if (!selBounds && !probeCompleted && lastErr) {
    var probeErr = new Error("选区检测失败: " + (lastErr.message || String(lastErr)));
    probeErr.code = "SELECTION_DETECTION_FAILED";
    throw probeErr;
  }
  if (!selBounds) {
    var err = new Error("NO_SELECTION|未检测到活动选区");
    throw err;
  }
  return selBounds;
}

function targetSize(sel) {
  var tw = sel.width, th = sel.height;
  if (tw > MAX_EDGE || th > MAX_EDGE) {
    if (tw > th) { th = Math.round(th * (MAX_EDGE / tw)); tw = MAX_EDGE; }
    else { tw = Math.round(tw * (MAX_EDGE / th)); th = MAX_EDGE; }
  }
  return { width: tw, height: th };
}

function toUint8Pixels(rawBuf, pw, ph, comp) {
  var expected = pw * ph * comp;
  var rawIsUint16 = (typeof Uint16Array !== "undefined" && rawBuf instanceof Uint16Array);
  var rawIsFloat32 = (typeof Float32Array !== "undefined" && rawBuf instanceof Float32Array);
  var pixels;
  if (rawBuf instanceof Uint8Array) {
    pixels = rawBuf;
  } else if (rawIsUint16) {
    var maxSampleVal = 0;
    var sampleLimit = Math.min(rawBuf.length, 5000);
    for (var smi = 0; smi < sampleLimit; smi++) {
      if (rawBuf[smi] > maxSampleVal) maxSampleVal = rawBuf[smi];
    }
    var isPS32768 = (maxSampleVal > 0 && maxSampleVal <= 32769);
    pixels = new Uint8Array(expected);
    for (var i = 0; i < expected && i < rawBuf.length; i++) {
      pixels[i] = isPS32768
        ? Math.min(255, Math.round(rawBuf[i] * 255 / 32768))
        : Math.min(255, (rawBuf[i] + 128) >> 8);
    }
    return pixels;
  } else if (rawIsFloat32) {
    pixels = new Uint8Array(expected);
    for (var j = 0; j < expected && j < rawBuf.length; j++) {
      var fval = rawBuf[j];
      if (fval < 0) fval = 0;
      if (fval > 1) fval = 1;
      pixels[j] = Math.round(fval * 255);
    }
    return pixels;
  } else if (rawBuf instanceof ArrayBuffer) {
    pixels = new Uint8Array(rawBuf);
  } else if (rawBuf && rawBuf.buffer) {
    pixels = new Uint8Array(rawBuf.buffer);
  } else {
    pixels = new Uint8Array(rawBuf);
  }

  var expected16 = expected * 2;
  if (!rawIsUint16 && !rawIsFloat32 && pixels.length === expected16 && pixels.length !== expected) {
    var sumEven = 0, sumOdd = 0;
    var sampleCount = Math.min(100, expected);
    for (var si = 0; si < sampleCount; si++) {
      sumEven += pixels[si * 2];
      sumOdd += pixels[si * 2 + 1];
    }
    var isBE = (sumEven >= sumOdd);
    var pixels8 = new Uint8Array(expected);
    var maxVal16b = 0;
    var checkLimit = Math.min(5000, expected);
    for (var ci = 0; ci < checkLimit; ci++) {
      var hb = pixels[ci * 2 + (isBE ? 0 : 1)];
      var lb = pixels[ci * 2 + (isBE ? 1 : 0)];
      var v16 = (hb << 8) | lb;
      if (v16 > maxVal16b) maxVal16b = v16;
    }
    var isPS16 = (maxVal16b > 0 && maxVal16b <= 32769);
    for (var bi = 0; bi < expected; bi++) {
      var hiB = pixels[bi * 2 + (isBE ? 0 : 1)];
      var loB = pixels[bi * 2 + (isBE ? 1 : 0)];
      var val16b = (hiB << 8) | loB;
      pixels8[bi] = isPS16
        ? Math.min(255, Math.round(val16b * 255 / 32768))
        : Math.min(255, (val16b + 128) >> 8);
    }
    pixels = pixels8;
  }

  if (pixels.length !== expected) {
    if (pixels.length > expected) pixels = pixels.subarray(0, expected);
    else {
      var padded = new Uint8Array(expected);
      padded.set(pixels);
      pixels = padded;
    }
  }
  return pixels;
}

/**
 * capture(predefinedSelection | { selection }, [opts])
 * returns { base64, selection, width, height, docId }
 */
async function capture(predefinedSelection, opts) {
  photoshop = photoshop || require("photoshop");
  if (predefinedSelection && predefinedSelection.selection && predefinedSelection.left == null) {
    opts = predefinedSelection;
    predefinedSelection = predefinedSelection.selection;
  }
  var app = photoshop.app;
  var core = photoshop.core;
  var imaging = photoshop.imaging;
  if (!app || !core || !imaging || !imaging.getPixels) {
    throw new Error("imaging.getPixels 不可用");
  }

  var result = null;
  await core.executeAsModal(async function () {
    var doc = app.activeDocument;
    if (!doc) throw new Error("没有打开的文档");

    var selBounds;
    if (predefinedSelection) {
      selBounds = {
        left: Math.round(predefinedSelection.left),
        top: Math.round(predefinedSelection.top),
        right: Math.round(predefinedSelection.right),
        bottom: Math.round(predefinedSelection.bottom),
        width: Math.round(predefinedSelection.width != null
          ? predefinedSelection.width
          : predefinedSelection.right - predefinedSelection.left),
        height: Math.round(predefinedSelection.height != null
          ? predefinedSelection.height
          : predefinedSelection.bottom - predefinedSelection.top)
      };
      if (!(selBounds.width > 0) || !(selBounds.height > 0)) {
        throw new Error("NO_SELECTION|预定义选区无效");
      }
    } else {
      selBounds = await detectSelection(app, doc);
    }

    var ts = targetSize(selBounds);
    var gpOpts = {
      documentID: doc.id,
      sourceBounds: {
        left: selBounds.left,
        top: selBounds.top,
        right: selBounds.right,
        bottom: selBounds.bottom
      },
      targetSize: { width: ts.width, height: ts.height },
      componentSize: 8,
      colorSpace: "RGB",
      applyAlpha: false
    };
    log("getPixels sourceBounds " + selBounds.width + "x" + selBounds.height);

    var pixelData;
    try {
      pixelData = await imaging.getPixels(gpOpts);
    } catch (gpErr) {
      delete gpOpts.componentSize;
      pixelData = await imaging.getPixels(gpOpts);
    }

    var imgObj = pixelData.imageData || pixelData;
    var comp = imgObj.components || 3;
    var pw = imgObj.width, ph = imgObj.height;
    var rawBuf;
    if (typeof imgObj.getData === "function") {
      rawBuf = await imgObj.getData({});
    } else {
      rawBuf = imgObj.data;
    }
    var pixels = toUint8Pixels(rawBuf, pw, ph, comp);
    var pngBytes = encode.encodePNGFromRGB(pw, ph, pixels, comp);
    var resultBase64 = encode.arrayBufferToBase64(pngBytes.buffer);
    result = {
      base64: resultBase64,
      selection: selBounds,
      width: pw,
      height: ph,
      docId: doc.id
    };
    try { if (imgObj.dispose) imgObj.dispose(); } catch (_) {}
    try { if (pixelData.imageData && pixelData.imageData.dispose) pixelData.imageData.dispose(); } catch (_) {}
  }, { commandName: "PXD/LS capture" });

  if (!result) throw new Error("抓取失败");
  return result;
}

/** Exact production capture, called while the caller holds a Photoshop modal scope.
 * Unlike the Alpha thumbnail path, this does not guess pixel depths, pad/truncate
 * bad buffers, resize, or replace a selection by its enclosing rectangle.
 */
function createProductionCapture(ps, codec, options) {
  options = options || {};
  var pixelTools = options.pixelTools || require("./ps-pixels-014.js");
  var hostError = require("./ps-pixels-014.js").createHostError;
  function reject(code, message) { throw hostError(code, message); }
  function value(v) { return typeof v === "number" ? v : Number(v && (v._value != null ? v._value : v.value != null ? v.value : v)); }
  function checkBounds(bounds, doc) {
    if (!bounds) reject("NO_SELECTION", "未检测到活动选区；请创建选区或明确使用整图模式");
    var result = { left: Math.floor(value(bounds.left)), top: Math.floor(value(bounds.top)), right: Math.ceil(value(bounds.right)), bottom: Math.ceil(value(bounds.bottom)) };
    if (!Object.keys(result).every(function (key) { return Number.isFinite(result[key]); }) || result.left < 0 || result.top < 0 || result.right > value(doc.width) || result.bottom > value(doc.height) || result.right <= result.left || result.bottom <= result.top) reject("UNSUPPORTED_BOUNDS", "选区范围无效或超出画布，未自动裁切");
    pixelTools.dimensions(result.right - result.left, result.bottom - result.top); return result;
  }
  function matches(a, b) { return !a || ["left", "top", "right", "bottom"].every(function (k) { return value(a[k]) === b[k]; }); }
  async function readPixels(result, source, components) {
    var data = result && result.imageData;
    if (!data) reject("HOST_PIXEL_FORMAT", "Photoshop 未返回图像数据");
    try {
      if (!matches(result.sourceBounds, source) || data.width !== source.right - source.left || data.height !== source.bottom - source.top || components.indexOf(data.components) < 0 || data.componentSize !== 8) reject("HOST_PIXEL_FORMAT", "Photoshop 返回的像素范围、通道或位深与原始范围不匹配，未自动缩放");
      var pixels = await data.getData({ chunky: true });
      if (!(pixels instanceof Uint8Array) || pixels.length !== data.width * data.height * data.components) reject("HOST_PIXEL_FORMAT", "Photoshop 返回的像素缓冲区不完整");
      var owned = new Uint8Array(pixels);
      return { width: data.width, height: data.height, components: data.components, pixels: owned };
    } finally { if (data.dispose) data.dispose(); }
  }
  function encoded(data) {
    var png = pixelTools.encodePNG(data.width, data.height, data.pixels, data.components);
    return { base64: codec.arrayBufferToBase64(png.buffer), mimeType: "image/png", width: data.width, height: data.height };
  }
  return async function captureInModal(doc, scope) {
    if (scope !== "selection" && scope !== "document") reject("INVALID_INPUT", "必须明确选择选区或整图模式");
    if (!ps.imaging || !ps.imaging.getPixels) reject("HOST_UNSUPPORTED", "此 Photoshop 版本不支持生产像素读取");
    var rawDepth = doc.bitsPerChannel, depth = null, bitTypes = ps.constants && ps.constants.BitsPerChannelType;
    if (rawDepth === 8 || rawDepth === "8" || rawDepth === "bitDepth8" || bitTypes && rawDepth === bitTypes.EIGHT) depth = 8;
    else if (rawDepth === 16 || rawDepth === "16" || rawDepth === "bitDepth16" || bitTypes && rawDepth === bitTypes.SIXTEEN) depth = 16;
    if (depth == null) reject("UNSUPPORTED_DOCUMENT", "生产捕获暂支持 8/16 位文档；32 位 HDR 或未知位深需要单独转换确认");
    var source;
    if (scope === "selection") {
      if (!ps.imaging.getSelection) reject("HOST_UNSUPPORTED", "此 Photoshop 版本无法读取真实选区蒙版，未使用矩形替代");
      var selectionBounds;
      try { selectionBounds = doc.selection && doc.selection.bounds; }
      catch (_) { reject("NO_SELECTION", "未检测到活动选区；请创建选区或明确使用整图模式"); }
      source = checkBounds(selectionBounds, doc);
    } else source = checkBounds({ left: 0, top: 0, right: value(doc.width), bottom: value(doc.height) }, doc);
    var maskData = null;
    if (scope === "selection") {
      maskData = await readPixels(await ps.imaging.getSelection({ documentID: doc.id, sourceBounds: source }), source, [1]);
      if (!maskData.pixels.some(function (v) { return v > 0; })) reject("NO_SELECTION", "当前选区蒙版为空");
    }
    var imageData = await readPixels(await ps.imaging.getPixels({ documentID: doc.id, sourceBounds: source, componentSize: 8, colorSpace: "RGB", colorProfile: "sRGB IEC61966-2.1", applyAlpha: false }), source, [3, 4]);
    var result = { scope: scope, transform: { sourceBounds: source, inputWidth: imageData.width, inputHeight: imageData.height }, image: encoded(imageData), adaptation: { colorSpace: "sRGB", colorProfile: "sRGB IEC61966-2.1", bitDepth: 8, sourceBitDepth: Number(depth), sourceMode: String(doc.mode), resized: false, transparency: imageData.components === 4 ? "preserved" : "opaque" } };
    if (maskData) { result.mask = encoded(maskData); result.maskPixels = maskData.pixels; }
    return result;
  };
}

var _api = { capture: capture, detectSelection: detectSelection, createProductionCapture: createProductionCapture };
if (typeof module !== "undefined" && module.exports) module.exports = _api;
var _g = (typeof window !== "undefined") ? window : (typeof globalThis !== "undefined" ? globalThis : this);
_g.ps = _g.ps || {};
_g.ps.capture = capture;
