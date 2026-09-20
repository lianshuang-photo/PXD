/* PXD/LS studio — UXP panel. Native HTML, no iframe. */
(function () {
  const ui = window.PXD_UI;

  const runtimeBase = window.PXD_RUNTIME && window.PXD_RUNTIME.companionBase;
  const DEFAULT_BASE = runtimeBase || "http://127.0.0.1:17880";
  // V2 preview always talks to the service that served /ui/. Native development
  // uses its isolated service, never the preserved installed Alpha by default.
  const previewOrigin = window.location && /^https?:$/.test(window.location.protocol) && /^\/ui(?:\/|$)/.test(window.location.pathname) ? window.location.origin : null;
  const serviceInput = document.getElementById("baseUrl");
  if (serviceInput) {
    if (previewOrigin) { serviceInput.value = previewOrigin; serviceInput.setAttribute("readonly", ""); }
    else if (!serviceInput.value || runtimeBase && /:17880\/?$/.test(serviceInput.value)) serviceInput.value = DEFAULT_BASE;
  }
  const SHARED_STUDIO = true;
  /* global window.ps from <script src="ps-encode/capture/return"> — not function ps() */
  const hostPs = (typeof window !== "undefined" && window.ps) ? window.ps : {};

  function ps() {
    try {
      if (typeof require === "function") return require("photoshop");
    } catch (_) {}
    return null;
  }

  function app() {
    const p = ps();
    return p && p.app ? p.app : null;
  }

  function core() {
    const p = ps();
    return p && p.core ? p.core : null;
  }

  function action() {
    const p = ps();
    return p && p.action ? p.action : null;
  }

  function imaging() {
    const p = ps();
    return p && p.imaging ? p.imaging : null;
  }

  function uxpStorage() {
    try {
      if (typeof require === "function") {
        const uxp = require("uxp");
        return uxp && uxp.storage;
      }
    } catch (_) {}
    return null;
  }

  let lastCapture = null;
  let lastResultLayerId = null;
  let loadedRecipeId = null;
  const MAX_REFS = 4;
  const MAX_RECORDS = 30;
  let attachedRefs = [];
  let taskRecords = [];

  function arrayBufferToBase64(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const chunks = [];
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize)));
    }
    return btoa(chunks.join(""));
  }

  function base64ToArrayBuffer(base64) {
    const raw = String(base64 || "").replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, "");
    const binary = atob(raw);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  function encodePNGFromRGB(w, h, rgbData, comp) {
    comp = comp || 3;
    function u32be(a, o, v) {
      a[o] = (v >>> 24) & 0xFF; a[o + 1] = (v >>> 16) & 0xFF;
      a[o + 2] = (v >>> 8) & 0xFF; a[o + 3] = v & 0xFF;
    }
    let ct = null;
    function crc32(buf, s, len) {
      if (!ct) {
        ct = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
          let c = n;
          for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
          ct[n] = c;
        }
      }
      let crc = 0xFFFFFFFF;
      for (let i = s; i < s + len; i++) crc = ct[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
      return (crc ^ 0xFFFFFFFF) >>> 0;
    }
    const rowB = 1 + w * 3, rawSz = rowB * h;
    const raw = new Uint8Array(rawSz);
    for (let y = 0; y < h; y++) {
      raw[y * rowB] = 0;
      for (let x = 0; x < w; x++) {
        const si = (y * w + x) * comp, di = y * rowB + 1 + x * 3;
        raw[di] = rgbData[si]; raw[di + 1] = rgbData[si + 1]; raw[di + 2] = rgbData[si + 2];
      }
    }
    const MX = 65535, nBlk = Math.ceil(rawSz / MX);
    const dfSz = 2 + nBlk * 5 + rawSz + 4;
    const df = new Uint8Array(dfSz);
    df[0] = 0x78; df[1] = 0x01;
    let p = 2;
    for (let bi = 0; bi < nBlk; bi++) {
      const bStart = bi * MX, bLen = Math.min(MX, rawSz - bStart);
      df[p++] = (bi === nBlk - 1) ? 1 : 0;
      df[p++] = bLen & 0xFF; df[p++] = (bLen >> 8) & 0xFF;
      df[p++] = (~bLen) & 0xFF; df[p++] = ((~bLen) >> 8) & 0xFF;
      df.set(raw.subarray(bStart, bStart + bLen), p); p += bLen;
    }
    let a1 = 1, a2 = 0;
    for (let ai = 0; ai < rawSz; ai++) { a1 = (a1 + raw[ai]) % 65521; a2 = (a2 + a1) % 65521; }
    const adl = ((a2 << 16) | a1) >>> 0;
    df[p++] = (adl >>> 24) & 0xFF; df[p++] = (adl >>> 16) & 0xFF;
    df[p++] = (adl >>> 8) & 0xFF; df[p++] = adl & 0xFF;
    const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const ihdr = new Uint8Array(25);
    u32be(ihdr, 0, 13); ihdr[4] = 73; ihdr[5] = 72; ihdr[6] = 68; ihdr[7] = 82;
    u32be(ihdr, 8, w); u32be(ihdr, 12, h);
    ihdr[16] = 8; ihdr[17] = 2; ihdr[18] = 0; ihdr[19] = 0; ihdr[20] = 0;
    u32be(ihdr, 21, crc32(ihdr, 4, 17));
    const idat = new Uint8Array(4 + 4 + dfSz + 4);
    u32be(idat, 0, dfSz); idat[4] = 73; idat[5] = 68; idat[6] = 65; idat[7] = 84;
    idat.set(df, 8); u32be(idat, 8 + dfSz, crc32(idat, 4, 4 + dfSz));
    const iend = new Uint8Array(12);
    u32be(iend, 0, 0); iend[4] = 73; iend[5] = 69; iend[6] = 78; iend[7] = 68;
    u32be(iend, 8, crc32(iend, 4, 4));
    const png = new Uint8Array(sig.length + ihdr.length + idat.length + iend.length);
    png.set(sig, 0);
    png.set(ihdr, sig.length);
    png.set(idat, sig.length + ihdr.length);
    png.set(iend, sig.length + ihdr.length + idat.length);
    return png;
  }

  function num(v) {
    if (v == null) return undefined;
    if (typeof v === "number") return v;
    if (typeof v === "object" && v._value != null) return v._value;
    return Number(v);
  }

  function showThumb96(b64) {
    const el = $("capThumb");
    if (!el) return;
    if (!b64) { el.hidden = true; el.removeAttribute("src"); return; }
    el.src = "data:image/png;base64," + String(b64).replace(/^data:image\/[^;]+;base64,/, "");
    el.hidden = false;
  }

  async function probeSelectionBounds(doc, act) {
    if (!doc) return null;
    try {
      const b = doc && doc.selection && doc.selection.bounds;
      if (b && typeof b.left === "number" && b.right - b.left > 0) {
        return {
          left: Math.round(b.left), top: Math.round(b.top),
          right: Math.round(b.right), bottom: Math.round(b.bottom),
          width: Math.round(b.right - b.left), height: Math.round(b.bottom - b.top),
          source: "dom"
        };
      }
      if (doc.selection) return null;
    } catch (_) {}
    if (!act || !act.batchPlay) return null;
    try {
      const res = await act.batchPlay([{
        _obj: "get",
        _target: [{ _property: "selection" }, { _ref: "document", _id: doc.id }],
        _options: { dialogOptions: "dontDisplay" }
      }], { synchronousExecution: true });
      const sel = res && res[0] && res[0].selection;
      const L = num(sel && sel.left), T = num(sel && sel.top), R = num(sel && sel.right), B = num(sel && sel.bottom);
      if (L != null && R != null && R - L > 0) {
        return { left: Math.round(L), top: Math.round(T), right: Math.round(R), bottom: Math.round(B), width: Math.round(R - L), height: Math.round(B - T), source: "batchPlay" };
      }
    } catch (_) {}
    return null;
  }

  function sameSelection(a, b) {
    if (!a || !b) return false;
    const keys = ["left", "top", "right", "bottom"];
    for (let i = 0; i < keys.length; i++) {
      const ka = keys[i];
      if (Math.round(Number(a[ka])) !== Math.round(Number(b[ka]))) return false;
    }
    return true;
  }

  function captureUsable(cap) {
    return !!(cap && cap.base64 && cap.selection);
  }

  /* New live rect vs lastCapture.selection. No live sel is NOT "new". */
  function userMadeNewSelection(liveSel, cap) {
    if (!liveSel) return false;
    if (!captureUsable(cap) || !cap.selection) return true;
    return !sameSelection(liveSel, cap.selection);
  }

  /* 轮椅 重跑不重抓: reuse lastCapture pixels+selection unless the user drew a new rect.
     NO_SELECTION + lastCapture still returns lastCapture. Never full-doc getPixels. */
  async function addSelectionAsRef(liveSel) {
    if (!liveSel) return;
    if (attachedRefs.length >= MAX_REFS) {
      setRefNote("已丢弃 1 张（最多 4 张参考）");
      return;
    }
    const saved = lastCapture;
    try {
      const crop = await psCapture(liveSel, { skipPersist: true });
      if (crop && crop.base64) {
        attachedRefs.push({
          base64: crop.base64,
          dataUrl: "data:image/png;base64," + crop.base64
        });
        if (attachedRefs.length > MAX_REFS) attachedRefs.length = MAX_REFS;
        renderRefThumbs();
        log("参考：选区裁切 " + (crop.selection && crop.selection.width) + "x" + (crop.selection && crop.selection.height), "ok");
      }
    } catch (ce) {
      const cm = String(ce && ce.message ? ce.message : ce);
      log(cm.indexOf("NO_SELECTION") !== -1 ? "NO_SELECTION" : ("参考抓取失败: " + cm), "err");
    }
    lastCapture = saved;
    if (saved && saved.base64) showThumb96(saved.base64);
  }

  async function reuseOrRecapture(liveSel) {
    const scope = selScope();
    if ((scope === "ref" || isIgnoreScope()) && captureUsable(lastCapture)) {
      if (scope === "ref" && liveSel && userMadeNewSelection(liveSel, lastCapture)) {
        await addSelectionAsRef(liveSel);
      }
      log("抓图：复用选区 " + (lastCapture.selection && lastCapture.selection.width) + "x" + (lastCapture.selection && lastCapture.selection.height), "ok");
      showThumb96(lastCapture.base64);
      return lastCapture;
    }
    if (captureUsable(lastCapture) && !userMadeNewSelection(liveSel, lastCapture)) {
      log("抓图：复用选区 " + (lastCapture.selection && lastCapture.selection.width) + "x" + (lastCapture.selection && lastCapture.selection.height), "ok");
      showThumb96(lastCapture.base64);
      return lastCapture;
    }
    if (!liveSel && !captureUsable(lastCapture)) {
      throw new Error("NO_SELECTION");
    }
    try {
      const cap = await psCapture(liveSel || undefined);
      lastCapture = cap;
      log("抓图：选区 " + (cap.selection && cap.selection.width) + "x" + (cap.selection && cap.selection.height), "ok");
      return cap;
    } catch (ce) {
      const cm = String(ce && ce.message ? ce.message : ce);
      if (cm.indexOf("NO_SELECTION") !== -1) {
        if (captureUsable(lastCapture)) {
          log("抓图：复用选区 " + (lastCapture.selection && lastCapture.selection.width) + "x" + (lastCapture.selection && lastCapture.selection.height), "ok");
          showThumb96(lastCapture.base64);
          return lastCapture;
        }
        log("NO_SELECTION", "err");
      } else {
        log("抓图失败: " + cm, "err");
      }
      throw ce;
    }
  }

  async function psCapture(predefinedSelection, opts) {
    opts = opts || {};
    if (hostPs && typeof hostPs.capture === "function") {
      const cap = await hostPs.capture(predefinedSelection ? { selection: predefinedSelection } : undefined);
      if (!cap || !cap.base64) throw new Error("NO_SELECTION");
      const captured = {
        ok: true,
        base64: cap.base64,
        selection: cap.selection,
        usedSelection: true,
        docId: cap.docId,
        width: cap.width,
        height: cap.height
      };
      lastCapture = captured;
      showThumb96(cap.base64);
      if (!opts.skipPersist) persistLastCapture(captured);
      return captured;
    }
    throw new Error("ps-capture 未加载");
  }

  function layerBoundsFrom(desc) {
    const b = desc && (desc.boundsNoEffects || desc.bounds);
    if (!b) return null;
    const L = num(b.left), T = num(b.top), R = num(b.right), B = num(b.bottom);
    return { left: L, top: T, width: R - L, height: B - T };
  }

  async function psReturn(base64Str, opts) {
    opts = opts || {};
    const c = core();
    const act = action();
    const a = app();
    const storage = uxpStorage();
    if (!c || !act || !a || !storage) return { applied: false, reason: "no-photoshop" };
    const sel = (opts.selection || (lastCapture && lastCapture.selection) || null);
    const layerType = opts.layerType || "smartObject";
    const groupName = opts.groupName || "PXD/LS";
    const fs = storage.localFileSystem;
    const formats = storage.formats;
    const tempFolder = await fs.getTemporaryFolder();
    const rawFile = await tempFolder.createFile("pxdls_place_" + Date.now() + ".png", { overwrite: true });
    await rawFile.write(base64ToArrayBuffer(base64Str), { format: formats.binary });
    let layerId = null;
    try {
      await c.executeAsModal(async (executionContext) => {
        let sus = null;
        try {
          if (executionContext && executionContext.hostControl && a.activeDocument) {
            sus = await executionContext.hostControl.suspendHistory({
              documentID: a.activeDocument.id,
              name: "PXD/LS return"
            });
          }
        } catch (_) {}
        const token = await fs.createSessionToken(rawFile);
        await act.batchPlay([{
          _obj: "placeEvent",
          null: { _path: token, _kind: "local" },
          freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSAverage" },
          offset: { _obj: "offset", horizontal: { _unit: "pixelsUnit", _value: 0 }, vertical: { _unit: "pixelsUnit", _value: 0 } }
        }], { synchronousExecution: true });
        if (sel && sel.width > 0 && sel.height > 0) {
          let br = await act.batchPlay([{
            _obj: "get",
            _target: [{ _property: "boundsNoEffects" }, { _ref: "layer", _enum: "ordinal", _value: "targetEnum" }]
          }], { synchronousExecution: true });
          let cur = layerBoundsFrom(br && br[0]);
          if (!cur || cur.width <= 0) {
            br = await act.batchPlay([{
              _obj: "get",
              _target: [{ _property: "bounds" }, { _ref: "layer", _enum: "ordinal", _value: "targetEnum" }]
            }], { synchronousExecution: true });
            cur = layerBoundsFrom(br && br[0]);
          }
          if (cur && cur.width > 0 && cur.height > 0) {
            const scaleX = (sel.width / cur.width) * 100;
            const scaleY = (sel.height / cur.height) * 100;
            if (Math.abs(scaleX - 100) > 0.01 || Math.abs(scaleY - 100) > 0.01) {
              await act.batchPlay([{
                _obj: "transform",
                _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
                freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSCorner0" },
                width: { _unit: "percentUnit", _value: scaleX },
                height: { _unit: "percentUnit", _value: scaleY },
                interfaceIconFrameDimmed: { _enum: "interpolationType", _value: "bicubicAutomatic" }
              }], { synchronousExecution: true });
            }
            const nb = await act.batchPlay([{
              _obj: "get",
              _target: [{ _property: "bounds" }, { _ref: "layer", _enum: "ordinal", _value: "targetEnum" }]
            }], { synchronousExecution: true });
            const after = layerBoundsFrom(nb && nb[0]) || cur;
            const moveX = sel.left - after.left;
            const moveY = sel.top - after.top;
            if (Math.abs(moveX) > 0.5 || Math.abs(moveY) > 0.5) {
              await act.batchPlay([{
                _obj: "move",
                _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
                to: { _obj: "offset", horizontal: { _unit: "pixelsUnit", _value: Math.round(moveX) }, vertical: { _unit: "pixelsUnit", _value: Math.round(moveY) } }
              }], { synchronousExecution: true });
            }
          }
        }
        if (layerType !== "smartObject") {
          await act.batchPlay([{ _obj: "rasterizeLayer", _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }] }], { synchronousExecution: true });
        }
        if (opts.maskFromSelection && sel) {
          const unit = (n) => ({ _unit: "pixelsUnit", _value: n });
          await act.batchPlay([{
            _obj: "set",
            _target: [{ _ref: "channel", _property: "selection" }],
            to: { _obj: "rectangle", top: unit(sel.top), left: unit(sel.left), bottom: unit(sel.bottom), right: unit(sel.right) }
          }], { synchronousExecution: true });
          await act.batchPlay([{
            _obj: "make",
            new: { _class: "channel" },
            at: { _ref: "channel", _enum: "channel", _value: "mask" },
            using: { _enum: "userMaskEnabled", _value: "revealSelection" }
          }], { synchronousExecution: true });
        }
        if (opts.group !== false) {
          await act.batchPlay([{
            _obj: "make",
            _target: [{ _ref: "layerSection" }],
            from: { _ref: "layer", _enum: "ordinal", _value: "targetEnum" },
            name: groupName
          }], { synchronousExecution: true });
          try {
            await act.batchPlay([{
              _obj: "set",
              _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
              to: { _obj: "layer", name: groupName }
            }], { synchronousExecution: true });
          } catch (_) {}
        }
        try {
          layerId = a.activeDocument.activeLayers[0].id;
        } catch (_) {}
        if (sus && executionContext && executionContext.hostControl) {
          try { await executionContext.hostControl.resumeHistory(sus); } catch (_) {}
        }
      }, { commandName: "PXD/LS return" });
    } finally {
      try { await rawFile.delete(); } catch (_) {}
    }
    return { applied: true, layerId: layerId, layerType: layerType, selection: sel };
  }

  async function returnAlign(base64Str, opts) {
    opts = opts || {};
    const sel = opts.selection || (lastCapture && lastCapture.selection) || null;
    if (hostPs && typeof hostPs.return === "function") {
      return await hostPs.return({
        base64: base64Str,
        selection: sel,
        docId: opts.docId != null ? opts.docId : (lastCapture && lastCapture.docId),
        layerType: opts.layerType || "smartObject",
        groupName: opts.groupName || "PXD/LS",
        group: opts.group
      });
    }
    return await psReturn(base64Str, opts);
  }

  function pickImageB64(obj) {
    if (!obj) return null;
    if (obj.imageBase64) return obj.imageBase64;
    if (obj.base64) return obj.base64;
    if (obj.image && obj.image.base64) return obj.image.base64;
    if (typeof obj.image === "string" && obj.image.length > 80) return obj.image;
    return null;
  }

  function applyIsMock(applied) {
    if (!applied) return false;
    if (applied.mock === true) return true;
    if (applied.vendor === "mock") return true;
    if (String(applied.reason || "") === "mock vendor") return true;
    if (String(applied.label || "") === "模拟供应商 不是香蕉") return true;
    if (String(applied.reason || "") === "模拟供应商 不是香蕉") return true;
    return false;
  }

  const MOCK_VENDOR_LABEL = "模拟供应商 不是香蕉";

  const $ = (id) => document.getElementById(id);
  const logEl = $("log");

  function log(msg, cls) {
    logEl.hidden = false;
    const d = document.createElement("div");
    d.className = "line" + (cls ? " " + cls : "");
    d.textContent = msg;
    logEl.appendChild(d);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function baseUrl() {
    const el = $("baseUrl");
    return previewOrigin || (el && el.value.trim()) || DEFAULT_BASE;
  }

  function selScope() {
    const on = document.querySelector("#selChips .chip.is-on, #proSelChips .chip.is-on");
    return on ? on.getAttribute("data-sel") : "scope";
  }

  function setSelScope(sel) {
    document.querySelectorAll("#selChips .chip, #proSelChips .chip").forEach(function (b) {
      b.classList.toggle("is-on", b.getAttribute("data-sel") === sel);
    });
    updatePrimaryLabel();
  }

  function isIgnoreScope() {
    const s = selScope();
    return s === "ignore" || s === "off";
  }

  function updatePrimaryLabel() {
    const go = $("go");
    const applyBtn = $("applyBtn");
    const txt = (($("proTa") && $("proTa").value) || ($("prompt") && $("prompt").value) || "");
    const wantGen = /出图|生成|香蕉/.test(txt);
    const label = wantGen ? "出一张" : (selScope() === "scope" ? "改选区" : "应用到新层");
    if (applyBtn) applyBtn.textContent = label;
  }

  function refsPayload() {
    const out = [];
    for (let i = 0; i < attachedRefs.length && out.length < MAX_REFS; i++) {
      if (attachedRefs[i] && attachedRefs[i].base64) out.push({ base64: attachedRefs[i].base64 });
    }
    return out;
  }

  function snapshotCapture(cap) {
    if (!captureUsable(cap)) return null;
    const sel = cap.selection || null;
    return {
      ok: true,
      base64: cap.base64,
      selection: sel ? {
        left: sel.left, top: sel.top, right: sel.right, bottom: sel.bottom,
        width: sel.width, height: sel.height
      } : null,
      usedSelection: true,
      docId: cap.docId,
      width: cap.width,
      height: cap.height
    };
  }

  function persistLastCapture(cap) {
    try {
      const snap = snapshotCapture(cap);
      if (!snap) return;
      localStorage.setItem("pxdls.lastCapture", JSON.stringify({
        base64: snap.base64,
        selection: snap.selection,
        docId: snap.docId,
        width: snap.width,
        height: snap.height
      }));
    } catch (_) {}
  }

  function restoreLastCapture() {
    try {
      const raw = localStorage.getItem("pxdls.lastCapture");
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || !obj.base64 || !obj.selection) return null;
      return {
        ok: true,
        base64: obj.base64,
        selection: obj.selection,
        usedSelection: true,
        docId: obj.docId,
        width: obj.width,
        height: obj.height
      };
    } catch (_) {
      return null;
    }
  }

  function persistRecords() {
    try {
      const rows = [];
      for (let i = 0; i < taskRecords.length && rows.length < 20; i++) {
        const rec = taskRecords[i];
        if (!rec) continue;
        rows.push({
          ts: rec.ts,
          text: rec.text,
          recipeId: rec.recipeId,
          selectionWh: rec.selectionWh,
          reusedCapture: !!rec.reusedCapture,
          generated: !!rec.generated,
          reason: rec.reason || ""
        });
      }
      localStorage.setItem("pxdls.records", JSON.stringify(rows));
    } catch (_) {}
  }

  function restoreRecords() {
    try {
      const raw = localStorage.getItem("pxdls.records");
      if (!raw) return [];
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      const out = [];
      for (let i = 0; i < arr.length && out.length < 20; i++) {
        const r = arr[i];
        if (!r || typeof r !== "object") continue;
        out.push({
          ts: r.ts,
          text: r.text || "",
          recipeId: r.recipeId || null,
          selectionWh: r.selectionWh || "",
          reusedCapture: !!r.reusedCapture,
          generated: !!r.generated,
          reason: r.reason || "",
          capture: null
        });
      }
      return out;
    } catch (_) {
      return [];
    }
  }

  function gcdInt(a, b) {
    a = Math.abs(Math.round(a));
    b = Math.abs(Math.round(b));
    while (b) { const t = a % b; a = b; b = t; }
    return a || 1;
  }

  function dimsFromCapture(cap) {
    if (!cap) return null;
    const sel = cap.selection || null;
    let w = 0, h = 0;
    if (sel) {
      w = Number(sel.width);
      h = Number(sel.height);
      if (!(w > 0 && h > 0) && sel.right != null && sel.left != null && sel.bottom != null && sel.top != null) {
        w = Number(sel.right) - Number(sel.left);
        h = Number(sel.bottom) - Number(sel.top);
      }
    }
    if (!(w > 0 && h > 0)) {
      w = Number(cap.width);
      h = Number(cap.height);
    }
    if (!(w > 0 && h > 0)) return null;
    return { w: w, h: h };
  }

  function tokenAspectFromDims(w, h) {
    w = Math.max(1, Math.round(Number(w)));
    h = Math.max(1, Math.round(Number(h)));
    const tokens = [[1, 1], [3, 4], [4, 3], [16, 9], [9, 16], [3, 2], [2, 3]];
    const r = w / h;
    let best = null, bestRel = Infinity;
    for (let i = 0; i < tokens.length; i++) {
      const a = tokens[i][0], b = tokens[i][1];
      const rel = Math.abs(r - a / b) / (a / b);
      if (rel < bestRel) { bestRel = rel; best = a + ":" + b; }
    }
    if (bestRel <= 0.03) return best;
    const g = gcdInt(w, h);
    return Math.round(w / g) + ":" + Math.round(h / g);
  }

  function sizeTokenFromLongEdge(w, h) {
    const long = Math.max(Number(w) || 0, Number(h) || 0);
    if (long <= 1280) return "1K";
    if (long <= 2560) return "2K";
    return "4K";
  }

  function buildApplyBody(cap, promptText, doc, reused) {
    let prompt = promptText;
    const dims = dimsFromCapture(cap);
    const aspectRatio = dims ? tokenAspectFromDims(dims.w, dims.h) : "1:1";
    const size = dims ? sizeTokenFromLongEdge(dims.w, dims.h) : "1K";
    const body = {
      prompt: prompt,
      captureBase64: cap.base64,
      image: cap.base64,
      refs: refsPayload(),
      size: size,
      aspectRatio: aspectRatio,
      model: "AJbanana3",
      provider: "mock",
      selection: cap.selection,
      document: doc,
      docId: cap.docId,
      layerType: "smartObject",
      recipeId: loadedRecipeId
    };
    if (isIgnoreScope()) {
      const ignSel = (doc && doc.selection) || (cap && cap.selection) || null;
      if (ignSel) body.ignore = { selection: ignSel };
      if (String(prompt || "").indexOf("严禁改此区域") === -1) {
        body.prompt = (prompt ? String(prompt) + "\n" : "") + "严禁改此区域";
      }
    }
    if (reused) {
      body.reuseCapture = { base64: cap.base64, selection: cap.selection, docId: cap.docId };
    }
    return body;
  }

  function fmtHm(ts) {
    const d = new Date(ts);
    return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
  }

  function paintRecordList(list) {
    if (!list) return;
    list.innerHTML = "";
    for (let i = 0; i < taskRecords.length; i++) {
      const rec = taskRecords[i];
      const row = document.createElement("div");
      row.className = "record-row";
      const main = document.createElement("div");
      main.className = "record-main";
      main.textContent = fmtHm(rec.ts) + "  " + String(rec.text || "").slice(0, 40);
      const meta = document.createElement("div");
      meta.className = "record-meta";
      const bits = [];
      if (rec.recipeId) bits.push(String(rec.recipeId));
      bits.push(rec.selectionWh || "—");
      bits.push(rec.reusedCapture ? "复用" : "新抓");
      bits.push("generated " + (rec.generated ? "true" : "false"));
      if (rec.reason) bits.push(String(rec.reason));
      meta.textContent = bits.join(" · ");
      const btn = ui.createButton("record-rerun", "重跑", function () { rerunRecord(rec); });
      row.appendChild(main);
      row.appendChild(meta);
      row.appendChild(btn);
      list.appendChild(row);
    }
  }

  function renderRecords() {
    let list = $("recordList");
    let drawer = $("recordsDrawer");
    const card = $("resultCard");
    if (!list && card && card.parentNode) {
      drawer = drawer || document.createElement("div");
      if (!drawer.id) {
        drawer.id = "recordsDrawer";
        drawer.className = "records-drawer";
        card.parentNode.insertBefore(drawer, card.nextSibling);
      }
      const head = document.createElement("div");
      head.className = "records-head";
      head.textContent = "记录";
      list = document.createElement("div");
      list.id = "recordList";
      list.className = "record-list";
      drawer.appendChild(head);
      drawer.appendChild(list);
    }
    const empty = taskRecords.length === 0;
    if (drawer) drawer.hidden = true; // Professional history is rendered in recordListPro.
    paintRecordList(list);
    const proDrawer = $("recordsDrawerPro");
    const proList = $("recordListPro");
    if (proDrawer) proDrawer.hidden = empty;
    const proHist = $("proHist");
    if (proHist) proHist.hidden = false;
    if (proList) paintRecordList(proList);
  }

  function pushRecord(rec) {
    if (!rec) return;
    taskRecords.unshift(rec);
    if (taskRecords.length > MAX_RECORDS) taskRecords.length = MAX_RECORDS;
    persistRecords();
    renderRecords();
  }

  async function rerunRecord(rec) {
    if (!rec) return;
    const promptEl = $("prompt");
    if (promptEl) promptEl.value = rec.text || "";
    loadedRecipeId = rec.recipeId || null;
    hideEmptyChips();
    try {
      await runPipeline(rec.text, { pinnedCapture: rec.capture });
    } catch (e) {
      log(String(e && e.message ? e.message : e), "err");
    }
  }

  function refNoteVisible() {
    const el = $("refNote");
    return !!(el && !el.hidden && el.textContent);
  }

  function syncRefFold() {
    const fold = $("refFold");
    if (!fold) return;
    fold.hidden = attachedRefs.length === 0 && !refNoteVisible();
  }

  function setRefNote(msg) {
    const el = $("refNote");
    if (!el) return;
    if (!msg) { el.hidden = true; el.textContent = ""; syncRefFold(); return; }
    el.hidden = false;
    el.textContent = msg;
    syncRefFold();
  }

  function renderRefThumbs() {
    const box = $("refThumbs");
    const fold = $("refFold");
    if (!box) return;
    box.innerHTML = "";
    if (fold) fold.hidden = attachedRefs.length === 0 && !refNoteVisible();
    for (let i = 0; i < attachedRefs.length; i++) {
      const wrap = document.createElement("span");
      wrap.className = "ref-thumb-wrap";
      const img = document.createElement("img");
      img.className = "ref-thumb";
      img.alt = "参考 " + (i + 1);
      img.src = attachedRefs[i].dataUrl || ("data:image/png;base64," + attachedRefs[i].base64);
      const x = ui.createButton("ref-del", "×");
      x.setAttribute("aria-label", "移除参考 " + (i + 1));
      (function (idx) {
        x.addEventListener("click", function (ev) {
          ev.preventDefault();
          ev.stopPropagation();
          attachedRefs.splice(idx, 1);
          setRefNote("");
          renderRefThumbs();
        });
      })(i);
      wrap.appendChild(img);
      wrap.appendChild(x);
      box.appendChild(wrap);
    }
    paintProRefSlots();
  }

  function paintProRefSlots() {
    const slots = document.querySelectorAll("#proRefs i");
    slots.forEach(function (el, i) {
      const rec = attachedRefs[i];
      el.classList.toggle("on", !!rec);
      el.textContent = rec ? (["A","B","C","D"][i] || "+") : ("+" + (["A","B","C","D"][i] || ""));
      el.title = rec ? ("参考 " + (i + 1) + " · 再点替换") : "挂参考图，最多 4";
      el.style.backgroundImage = rec && rec.dataUrl ? ("url(" + rec.dataUrl + ")") : "";
      el.style.backgroundSize = rec ? "cover" : "";
    });
  }

  function dataUrlToBase64(str) {
    return String(str || "").replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, "");
  }

  function shrinkDataUrl(dataUrl) {
    return new Promise(function (resolve) {
      try {
        const img = new Image();
        img.onload = function () {
          try {
            let w = img.naturalWidth || img.width;
            let h = img.naturalHeight || img.height;
            if (!w || !h) { resolve(dataUrlToBase64(dataUrl)); return; }
            const scale = Math.min(1, 96 / Math.max(w, h));
            w = Math.max(1, Math.round(w * scale));
            h = Math.max(1, Math.round(h * scale));
            const canvas = document.createElement("canvas");
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext("2d");
            if (!ctx) { resolve(dataUrlToBase64(dataUrl)); return; }
            ctx.drawImage(img, 0, 0, w, h);
            let out = "";
            try { out = canvas.toDataURL("image/jpeg", 0.7); }
            catch (_) { out = canvas.toDataURL("image/png"); }
            resolve(dataUrlToBase64(out));
          } catch (_) { resolve(dataUrlToBase64(dataUrl)); }
        };
        img.onerror = function () { resolve(dataUrlToBase64(dataUrl)); };
        img.src = dataUrl;
      } catch (_) { resolve(dataUrlToBase64(dataUrl)); }
    });
  }

  function readFileAsDataUrl(file) {
    return new Promise(function (resolve, reject) {
      if (!file) return reject(new Error("no file"));
      const fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result || "")); };
      fr.onerror = function () { reject(fr.error); };
      fr.readAsDataURL(file);
    });
  }

  async function addRefFiles(fileList) {
    const files = [];
    if (!fileList) return;
    for (let i = 0; i < fileList.length; i++) {
      const f = fileList[i];
      if (!f) continue;
      if (f.type && String(f.type).indexOf("image/") !== 0) continue;
      files.push(f);
    }
    if (!files.length) return;
    const room = Math.max(0, MAX_REFS - attachedRefs.length);
    const take = files.slice(0, room);
    const dropped = files.length - take.length;
    for (let i = 0; i < take.length; i++) {
      try {
        const du = await readFileAsDataUrl(take[i]);
        const b64 = await shrinkDataUrl(du);
        if (b64) attachedRefs.push({ base64: b64, dataUrl: "data:image/jpeg;base64," + b64 });
      } catch (_) {}
    }
    if (attachedRefs.length > MAX_REFS) attachedRefs.length = MAX_REFS;
    setRefNote(dropped > 0 ? ("已丢弃 " + dropped + " 张（最多 4 张参考）") : "");
    renderRefThumbs();
  }

  function gateOn(id) {
    const el = $(id);
    return !!(el && el.classList.contains("on"));
  }

  function setConnected(ok) {
    const go = $("go");
    const applyBtn = $("applyBtn");
    const pro = $("readDoc");
    const proHint = $("offlineHint");
    const hint = $("compHint");
    // The Agent tracks its own transport and Codex handshake; /health alone
    // cannot determine whether conversation submission is available.
    if (applyBtn) {
      ui.setDisabled(applyBtn, !ok);
      applyBtn.title = ok ? "" : "未连接";
    }
    if (pro) {
      pro.title = ok ? "读文档" : "未连接";
    }
    if (proHint) {
      proHint.textContent = "未连接";
      proHint.hidden = true;
    }
    if (hint) hint.textContent = ok ? "已连接" : "未连接";
    const retry = $("compRetry");
    if (retry) retry.textContent = ok ? "重试" : "重试";
  }

  async function pingHealth() {
    const dot = $("healthDot");
    try {
      const r = await fetch(baseUrl() + "/health");
      const j = await r.json();
      const ok = j && (j.ok === true || j.status === "ok");
      dot.classList.toggle("on", ok);
      dot.classList.toggle("off", !ok);
      setConnected(ok);
      return j;
    } catch (_) {
      dot.classList.remove("on");
      dot.classList.add("off");
      setConnected(false);
      return null;
    }
  }

  /* ---- Photoshop document / selection (read) ---- */

  async function readSelectionBounds() {
    const a = app();
    const doc = a && a.activeDocument;
    const sel = await probeSelectionBounds(doc, action());
    if (!sel) return null;
    return { left: sel.left, top: sel.top, right: sel.right, bottom: sel.bottom, width: sel.width, height: sel.height };
  }

  async function readActiveLayerId() {
    try {
      const a = app();
      const layer = a && a.activeDocument && a.activeDocument.activeLayers && a.activeDocument.activeLayers[0];
      if (!layer || layer.id == null) return null;
      return layer.id;
    } catch (_) {
      return null;
    }
  }

  async function readDocumentState() {
    const a = app();
    const doc = a && a.documents.length ? a.activeDocument : null;
    if (!doc) {
      return { open: false, selection: null, note: "no active document" };
    }
    const sel = await probeSelectionBounds(doc, action());
    if (!a.activeDocument || a.activeDocument.id !== doc.id) return { open: false, selection: null, note: "document changed during read" };
    const layer = doc.activeLayers && doc.activeLayers[0];
    return {
      open: true,
      id: doc.id,
      name: doc.title || doc.name,
      width: doc.width,
      height: doc.height,
      resolution: doc.resolution,
      layer: layer && layer.name,
      layerId: layer && layer.id != null ? layer.id : null,
      selection: sel,
    };
  }

  /* ---- Writes: executeAsModal + batchPlay ---- */

  function makeCurvesBrightenDescriptor() {
    return {
      _obj: "make",
      _target: [{ _ref: "adjustmentLayer" }],
      using: {
        _obj: "adjustmentLayer",
        name: "PXD/LS brighten",
        type: {
          _obj: "curves",
          presetKind: { _enum: "presetKindType", _value: "presetKindCustom" },
          adjustment: [
            {
              _obj: "curvesAdjustment",
              channel: { _ref: "channel", _enum: "channel", _value: "composite" },
              curve: [
                { _obj: "paint", horizontal: 0, vertical: 0 },
                { _obj: "paint", horizontal: 128, vertical: 148 },
                { _obj: "paint", horizontal: 255, vertical: 255 },
              ],
            },
          ],
        },
      },
      _options: { dialogOptions: "dontDisplay" },
    };
  }

  async function applyBrightenInPs(plan) {
    const c = core();
    const act = action();
    if (!c || !act || !c.executeAsModal) {
      log("本机无 Photoshop 写接口，跳过落地。", "err");
      return { applied: false, reason: "no-photoshop", layerId: null };
    }
    if (isIgnoreScope()) {
      return { applied: false, reason: "ignore", layerId: null };
    }
    if (loadedRecipeId) {
      return { applied: false, reason: "recipe-constraint", layerId: null };
    }
    if (plan && (plan.refuse || planHasRecipeEdit(plan))) {
      return { applied: false, reason: plan.refuse ? "plan-refuse" : "recipe-constraint", layerId: null };
    }
    const live = await readSelectionBounds();
    const cached = lastCapture && lastCapture.selection;
    /* Never write without lastCapture.selection. Never empty layer + Levels on the whole document. */
    if (!cached) {
      log("无像素不回退全图", "err");
      return { applied: false, reason: "NO_SELECTION", layerId: null };
    }
    const sel = (selScope() === "scope" ? (live || cached) : (cached || live)) || cached;
    const hasSel = !!(sel && sel.left != null && (sel.width > 0 || (sel.right - sel.left) > 0));
    if (!hasSel) {
      log("NO_SELECTION", "err");
      return { applied: false, reason: "NO_SELECTION", layerId: null };
    }
    await c.executeAsModal(
      async () => {
        /* scope: restore cached only if no live marquee.
           ref: live is a ref crop — reselect lastCapture (sel) so Curves hit the subject. */
        if (sel && (selScope() !== "scope" || !live)) {
          const unit = (n) => ({ _unit: "pixelsUnit", _value: n });
          await act.batchPlay([{
            _obj: "set",
            _target: [{ _ref: "channel", _property: "selection" }],
            to: {
              _obj: "rectangle",
              top: unit(sel.top),
              left: unit(sel.left),
              bottom: unit(sel.bottom),
              right: unit(sel.right)
            },
            _options: { dialogOptions: "dontDisplay" }
          }], { synchronousExecution: true });
        }
        await act.batchPlay(
          [makeCurvesBrightenDescriptor()],
          { synchronousExecution: true }
        );
      },
      { commandName: "PXD/LS brighten" }
    );
    const layerId = await readActiveLayerId();
    return { applied: true, maskFromSelection: true, selection: sel, plan: plan, layerId: layerId };
  }

  function makeMaskRevealSelectionDescriptor() {
    return {
      _obj: "make",
      new: { _class: "channel" },
      at: { _ref: "channel", _enum: "channel", _value: "mask" },
      using: { _enum: "userMaskEnabled", _value: "revealSelection" },
      _options: { dialogOptions: "dontDisplay" }
    };
  }

  function makeAdjLayerForMaskDescriptor() {
    return {
      _obj: "make",
      _target: [{ _ref: "adjustmentLayer" }],
      using: {
        _obj: "adjustmentLayer",
        name: "PXD/LS mask",
        type: {
          _obj: "brightnessContrast",
          brightness: 0,
          contrast: 0
        }
      },
      _options: { dialogOptions: "dontDisplay" }
    };
  }

  /* First-class mask atom. Fail with {applied:false,reason} — never silent. */
  async function applyMaskFromSelection(opts) {
    opts = opts || {};
    const c = core();
    const act = action();
    const a = app();
    if (!c || !act || !c.executeAsModal) {
      return { applied: false, reason: "no-photoshop" };
    }
    if (!a || !a.activeDocument) {
      return { applied: false, reason: "no-document" };
    }
    if (isIgnoreScope()) {
      return { applied: false, reason: "ignore" };
    }
    const live = await readSelectionBounds();
    const cached = lastCapture && lastCapture.selection;
    const sel = opts.selection || live || cached;
    const hasSel = !!(sel && sel.left != null && (sel.width > 0 || (sel.right - sel.left) > 0));
    if (!hasSel) {
      return { applied: false, reason: "NO_SELECTION" };
    }
    const targetId = opts.layerId != null ? opts.layerId : lastResultLayerId;
    try {
      await c.executeAsModal(async () => {
        const unit = (n) => ({ _unit: "pixelsUnit", _value: n });
        /* Restore selection if no live marquee so revealSelection has something to use. */
        if (sel && (selScope() !== "scope" || !live)) {
          await act.batchPlay([{
            _obj: "set",
            _target: [{ _ref: "channel", _property: "selection" }],
            to: {
              _obj: "rectangle",
              top: unit(sel.top),
              left: unit(sel.left),
              bottom: unit(sel.bottom),
              right: unit(sel.right)
            },
            _options: { dialogOptions: "dontDisplay" }
          }], { synchronousExecution: true });
        }
        let targeted = false;
        if (targetId != null) {
          try {
            await act.batchPlay([{
              _obj: "select",
              _target: [{ _ref: "layer", _id: targetId }],
              makeVisible: false,
              _options: { dialogOptions: "dontDisplay" }
            }], { synchronousExecution: true });
            targeted = true;
          } catch (_) {
            targeted = false;
          }
        }
        if (!targeted) {
          await act.batchPlay([makeAdjLayerForMaskDescriptor()], { synchronousExecution: true });
        }
        await act.batchPlay([makeMaskRevealSelectionDescriptor()], { synchronousExecution: true });
      }, { commandName: "PXD/LS mask" });
    } catch (e) {
      return { applied: false, reason: String(e && e.message ? e.message : e) };
    }
    const layerId = await readActiveLayerId();
    return { applied: true, layerId: layerId, from: "selection", selection: sel };
  }

  function makeOuterGlowDescriptor() {
    return {
      _obj: "set",
      _target: [
        { _ref: "property", _property: "layerEffects" },
        { _ref: "layer", _enum: "ordinal", _value: "targetEnum" }
      ],
      to: {
        _obj: "layerEffects",
        scale: { _unit: "percentUnit", _value: 100 },
        outerGlow: {
          _obj: "outerGlow",
          enabled: true,
          present: true,
          showInDialog: true,
          mode: { _enum: "blendMode", _value: "screen" },
          color: { _obj: "RGBColor", red: 255, grain: 255, blue: 190 },
          opacity: { _unit: "percentUnit", _value: 75 },
          glowTechnique: { _enum: "matteTechnique", _value: "softMatte" },
          chokeMatte: { _unit: "pixelsUnit", _value: 0 },
          blur: { _unit: "pixelsUnit", _value: 21 },
          noise: { _unit: "percentUnit", _value: 0 },
          shadingNoise: { _unit: "percentUnit", _value: 0 },
          antiAlias: false,
          transferSpec: { _obj: "shapeCurveType", name: "Linear" },
          inputRange: { _unit: "percentUnit", _value: 50 },
          transparency: true
        }
      },
      _options: { dialogOptions: "dontDisplay" }
    };
  }

  /* First-class fx atom. Fail with {applied:false,reason} — never silent. */
  async function applyFxInPs(opts) {
    opts = opts || {};
    const c = core();
    const act = action();
    const a = app();
    if (!c || !act || !c.executeAsModal) {
      return { applied: false, reason: "no-photoshop" };
    }
    if (!a || !a.activeDocument) {
      return { applied: false, reason: "no-document" };
    }
    const fx = opts.fx || "outerGlow";
    if (fx !== "outerGlow") {
      return { applied: false, reason: "unsupported-fx" };
    }
    let targetId = opts.layerId != null ? opts.layerId : lastResultLayerId;
    if (targetId == null) {
      try {
        const layers = a.activeDocument.layers;
        if (layers && layers.length) {
          const last = layers[layers.length - 1];
          if (last && last.id != null) targetId = last.id;
        }
      } catch (_) {}
    }
    try {
      await c.executeAsModal(async () => {
        let targeted = false;
        if (targetId != null) {
          try {
            await act.batchPlay([{
              _obj: "select",
              _target: [{ _ref: "layer", _id: targetId }],
              makeVisible: false,
              _options: { dialogOptions: "dontDisplay" }
            }], { synchronousExecution: true });
            targeted = true;
          } catch (_) {
            targeted = false;
          }
        }
        if (!targeted) {
          try {
            await act.batchPlay([{
              _obj: "select",
              _target: [{ _ref: "layer", _enum: "ordinal", _value: "last" }],
              makeVisible: false,
              _options: { dialogOptions: "dontDisplay" }
            }], { synchronousExecution: true });
          } catch (_) {
            /* keep current layer */
          }
        }
        await act.batchPlay([makeOuterGlowDescriptor()], { synchronousExecution: true });
      }, { commandName: "PXD/LS fx" });
    } catch (e) {
      return { applied: false, reason: String(e && e.message ? e.message : e) };
    }
    const layerId = await readActiveLayerId();
    return { applied: true, layerId: layerId, fx: "outerGlow" };
  }

  function makeHueSatGradeDescriptor() {
    return {
      _obj: "make",
      _target: [{ _ref: "adjustmentLayer" }],
      using: {
        _obj: "adjustmentLayer",
        name: "PXD/LS grade",
        type: {
          _obj: "hueSaturation",
          presetKind: { _enum: "presetKindType", _value: "presetKindCustom" },
          colorize: false,
          adjustment: [
            {
              _obj: "hueSatAdjustmentV2",
              hue: 0,
              saturation: 12,
              lightness: 0
            }
          ]
        }
      },
      _options: { dialogOptions: "dontDisplay" }
    };
  }

  /* First-class grade atom. lastCapture.selection required; never full-doc. Fail {applied:false,reason}. */
  async function applyGradeInPs(opts) {
    opts = opts || {};
    const c = core();
    const act = action();
    const a = app();
    if (!c || !act || !c.executeAsModal) {
      return { applied: false, reason: "no-photoshop" };
    }
    if (!a || !a.activeDocument) {
      return { applied: false, reason: "no-document" };
    }
    if (isIgnoreScope()) {
      return { applied: false, reason: "ignore" };
    }
    const live = await readSelectionBounds();
    const cached = lastCapture && lastCapture.selection;
    if (!cached) {
      return { applied: false, reason: "NO_SELECTION" };
    }
    const sel = opts.selection || cached;
    const hasSel = !!(sel && sel.left != null && (sel.width > 0 || (sel.right - sel.left) > 0));
    if (!hasSel) {
      return { applied: false, reason: "NO_SELECTION" };
    }
    try {
      await c.executeAsModal(async () => {
        const unit = (n) => ({ _unit: "pixelsUnit", _value: n });
        if (sel && (selScope() !== "scope" || !live)) {
          await act.batchPlay([{
            _obj: "set",
            _target: [{ _ref: "channel", _property: "selection" }],
            to: {
              _obj: "rectangle",
              top: unit(sel.top),
              left: unit(sel.left),
              bottom: unit(sel.bottom),
              right: unit(sel.right)
            },
            _options: { dialogOptions: "dontDisplay" }
          }], { synchronousExecution: true });
        }
        await act.batchPlay([makeHueSatGradeDescriptor()], { synchronousExecution: true });
      }, { commandName: "PXD/LS grade" });
    } catch (e) {
      return { applied: false, reason: String(e && e.message ? e.message : e) };
    }
    const layerId = await readActiveLayerId();
    return { applied: true, layerId: layerId, tool: "hue-sat", selection: sel };
  }

  function makeAdjustLayerDescriptor(kind) {
    if (kind === "levels") {
      return {
        _obj: "make",
        _target: [{ _ref: "adjustmentLayer" }],
        using: {
          _obj: "adjustmentLayer",
          name: "PXD/LS adjust-layer",
          type: {
            _obj: "levels",
            presetKind: { _enum: "presetKindType", _value: "presetKindDefault" }
          }
        },
        _options: { dialogOptions: "dontDisplay" }
      };
    }
    return {
      _obj: "make",
      _target: [{ _ref: "adjustmentLayer" }],
      using: {
        _obj: "adjustmentLayer",
        name: "PXD/LS adjust-layer",
        type: {
          _obj: "curves",
          presetKind: { _enum: "presetKindType", _value: "presetKindCustom" },
          adjustment: [
            {
              _obj: "curvesAdjustment",
              channel: { _ref: "channel", _enum: "channel", _value: "composite" },
              curve: [
                { _obj: "paint", horizontal: 0, vertical: 0 },
                { _obj: "paint", horizontal: 128, vertical: 128 },
                { _obj: "paint", horizontal: 255, vertical: 255 }
              ]
            }
          ]
        }
      },
      _options: { dialogOptions: "dontDisplay" }
    };
  }

  /* First-class adjust-layer atom. lastCapture.selection required; never full-doc. Fail {applied:false,reason}. */
  async function applyAdjustLayerInPs(opts) {
    opts = opts || {};
    const c = core();
    const act = action();
    const a = app();
    if (!c || !act || !c.executeAsModal) {
      return { applied: false, reason: "no-photoshop" };
    }
    if (!a || !a.activeDocument) {
      return { applied: false, reason: "no-document" };
    }
    if (isIgnoreScope()) {
      return { applied: false, reason: "ignore" };
    }
    const cached = lastCapture && lastCapture.selection;
    if (!cached) {
      return { applied: false, reason: "NO_SELECTION" };
    }
    const sel = opts.selection || cached;
    const hasSel = !!(sel && sel.left != null && (sel.width > 0 || (sel.right - sel.left) > 0));
    if (!hasSel) {
      return { applied: false, reason: "NO_SELECTION" };
    }
    const tool = opts.tool === "levels" ? "levels" : "curves";
    try {
      await c.executeAsModal(async () => {
        const unit = (n) => ({ _unit: "pixelsUnit", _value: n });
        await act.batchPlay([{
          _obj: "set",
          _target: [{ _ref: "channel", _property: "selection" }],
          to: {
            _obj: "rectangle",
            top: unit(sel.top),
            left: unit(sel.left),
            bottom: unit(sel.bottom),
            right: unit(sel.right)
          },
          _options: { dialogOptions: "dontDisplay" }
        }], { synchronousExecution: true });
        await act.batchPlay([makeAdjustLayerDescriptor(tool)], { synchronousExecution: true });
        try {
          await act.batchPlay([{
            _obj: "groupEvent",
            _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
            _options: { dialogOptions: "dontDisplay" }
          }], { synchronousExecution: true });
        } catch (_) {
          /* clip optional; mask from selection already applied */
        }
      }, { commandName: "PXD/LS adjust-layer" });
    } catch (e) {
      return { applied: false, reason: String(e && e.message ? e.message : e) };
    }
    const layerId = await readActiveLayerId();
    return { applied: true, layerId: layerId, tool: "curves-or-levels", selection: sel };
  }

  async function readbackSnapshot() {
    const a = app();
    if (!a) {
      return { applied: false, ok: false, reason: "HOST_MISSING" };
    }
    const doc = a.activeDocument;
    if (!doc) {
      return { applied: false, ok: false, reason: "HOST_MISSING", note: "no active document" };
    }
    const st = await readDocumentState();
    const sel = st.selection || null;
    const hasSelection = !!(sel && sel.left != null && (sel.width > 0 || (sel.right - sel.left) > 0));
    let layerBounds = null;
    try {
      const layer = doc.activeLayers && doc.activeLayers[0];
      const b = layer && layer.bounds;
      if (b) {
        layerBounds = {
          left: Math.round(b.left), top: Math.round(b.top),
          right: Math.round(b.right), bottom: Math.round(b.bottom),
          width: Math.round(b.right - b.left), height: Math.round(b.bottom - b.top)
        };
      }
    } catch (_) {}
    return {
      ok: true,
      applied: true,
      atom: "readback",
      snapshot: {
        document: {
          id: doc.id != null ? doc.id : null,
          name: st.name || null,
          width: st.width,
          height: st.height,
          bounds: null
        },
        layer: {
          id: st.layerId != null ? st.layerId : null,
          name: st.layer || null,
          bounds: layerBounds
        },
        selection: sel,
        hasSelection: hasSelection
      },
      document: { id: doc.id != null ? doc.id : null, name: st.name || null, width: st.width, height: st.height },
      layer: { id: st.layerId != null ? st.layerId : null, name: st.layer || null, bounds: layerBounds },
      selection: sel,
      hasSelection: hasSelection
    };
  }

  /* First-class select atom. Restore lastCapture.selection only. Never invent face. Never full-doc. */
  async function applySelectInPs(opts) {
    opts = opts || {};
    const c = core();
    const act = action();
    const a = app();
    if (!c || !act || !c.executeAsModal) {
      return { applied: false, reason: "no-photoshop" };
    }
    if (!a || !a.activeDocument) {
      return { applied: false, reason: "no-document" };
    }
    const sel = (lastCapture && lastCapture.selection) || null;
    const hasSel = !!(sel && sel.left != null && (sel.width > 0 || (sel.right - sel.left) > 0));
    if (!hasSel) {
      return { applied: false, reason: "NO_SELECTION" };
    }
    try {
      await c.executeAsModal(async () => {
        const unit = (n) => ({ _unit: "pixelsUnit", _value: n });
        await act.batchPlay([{
          _obj: "set",
          _target: [{ _ref: "channel", _property: "selection" }],
          to: {
            _obj: "rectangle",
            top: unit(sel.top),
            left: unit(sel.left),
            bottom: unit(sel.bottom),
            right: unit(sel.right)
          },
          _options: { dialogOptions: "dontDisplay" }
        }], { synchronousExecution: true });
      }, { commandName: "PXD/LS select" });
    } catch (e) {
      return { applied: false, reason: String(e && e.message ? e.message : e) };
    }
    return { applied: true, selection: sel };
  }

  async function selectFaceBox(box) {
    const c = core();
    const act = action();
    if (!c || !act || !box) return { selected: false };
    const unit = (n) => ({ _unit: "pixelsUnit", _value: n });
    await c.executeAsModal(
      async () => {
        await act.batchPlay(
          [
            {
              _obj: "set",
              _target: [{ _ref: "channel", _property: "selection" }],
              to: {
                _obj: "rectangle",
                top: unit(box.top),
                left: unit(box.left),
                bottom: unit(box.bottom),
                right: unit(box.right),
              },
              _options: { dialogOptions: "dontDisplay" },
            },
          ],
          { synchronousExecution: true }
        );
      },
      { commandName: "PXD/LS face-box" }
    );
    return { selected: true, box: box };
  }

  function isBrightenStep(step) {
    if (!step) return false;
    if (step.skill || (step.instruction && step.atom !== "brighten" && step.atom !== "face-box" && step.atom !== "mask" && step.atom !== "fx" && step.atom !== "grade" && step.atom !== "readback" && step.atom !== "select" && step.atom !== "adjust-layer")) return false;
    return step.atom === "brighten" || step.tool === "brighten";
  }

  function isMaskStep(step) {
    if (!step) return false;
    return step.atom === "mask" || step.tool === "mask";
  }

  function isFxStep(step) {
    if (!step) return false;
    return step.atom === "fx" || step.fx === "outerGlow";
  }

  function isGradeStep(step) {
    if (!step) return false;
    return step.atom === "grade" || step.tool === "hue-sat" || step.tool === "vibrance";
  }

  function isReadbackStep(step) {
    if (!step) return false;
    return step.atom === "readback";
  }

  function isSelectStep(step) {
    if (!step) return false;
    return step.atom === "select";
  }

  function isAdjustLayerStep(step) {
    if (!step) return false;
    return step.atom === "adjust-layer";
  }

  function planIsRefused(planRes) {
    if (!planRes) return false;
    if (planRes.refuse) return true;
    if (planRes.plan && planRes.plan.refuse) return true;
    return false;
  }

  function planRefuseReason(planRes) {
    if (!planRes) return "无法按生成默认提亮";
    if (planRes.plan && (planRes.plan.reason || planRes.plan.ask)) return planRes.plan.reason || planRes.plan.ask;
    return planRes.reason || "无法按生成默认提亮";
  }

  function isRecipeEditStep(step) {
    if (!step || step.kind !== "edit") return false;
    if (isBrightenStep(step) || step.atom === "face-box" || isMaskStep(step) || isFxStep(step) || isGradeStep(step) || isReadbackStep(step) || isSelectStep(step)) return false;
    return !!(step.skill || step.instruction || step.recipeId);
  }

  function planHasRecipeEdit(plan) {
    if (!plan) return false;
    if (plan.recipeId) return true;
    const steps = plan.steps || [];
    for (let i = 0; i < steps.length; i++) {
      if (isRecipeEditStep(steps[i])) return true;
    }
    return false;
  }

  function shouldApplyBrighten(plan) {
    if (!plan || plan.refuse) return false;
    if (loadedRecipeId) return false;
    if (planHasRecipeEdit(plan)) return false;
    const steps = plan.steps || [];
    for (let i = 0; i < steps.length; i++) {
      if (isBrightenStep(steps[i])) return true;
    }
    return false;
  }

  function faceBoxIsMock(box) {
    if (!box) return true;
    if (box.real === false) return true;
    if (box.source === "mock") return true;
    if (box.bounds && box.bounds.source === "mock") return true;
    return false;
  }


  async function applyLockInPs(step) {
    const c = core();
    const act = action();
    const a = app();
    const target = (step && step.target) || "skin-texture";
    const snapName = "PXD/LS lock " + target;
    if (!c || !act || !c.executeAsModal) {
      return { applied: false, reason: "no-photoshop" };
    }
    if (!a || !a.activeDocument) {
      return { applied: false, reason: "no-document" };
    }
    let applied = false;
    let how = "";
    let errReason = "";
    try {
      await c.executeAsModal(async (executionContext) => {
        try {
          await act.batchPlay([{
            _obj: "make",
            _target: [{ _ref: "snapshotClass" }],
            from: { _ref: "historyState", _property: "currentHistoryState" },
            name: snapName,
            using: { _enum: "historyState", _value: "fullDocument" },
            _options: { dialogOptions: "dontDisplay" }
          }], { synchronousExecution: true });
          applied = true;
          how = "history-snapshot";
        } catch (e1) {
          try {
            /* Dummy named checkpoint layer — do not edit existing/locked layers. */
            await act.batchPlay([{
              _obj: "make",
              _target: [{ _ref: "layer" }],
              using: { _obj: "layer", name: snapName },
              _options: { dialogOptions: "dontDisplay" }
            }], { synchronousExecution: true });
            applied = true;
            how = "dummy-snapshot-layer";
          } catch (e2) {
            try {
              if (executionContext && executionContext.hostControl && a.activeDocument) {
                const sus = await executionContext.hostControl.suspendHistory({
                  documentID: a.activeDocument.id,
                  name: snapName
                });
                await executionContext.hostControl.resumeHistory(sus);
                applied = true;
                how = "suspend-history-name";
              }
            } catch (e3) {
              errReason = String((e3 && e3.message) || (e2 && e2.message) || (e1 && e1.message) || e3 || e2 || e1);
            }
          }
        }
      }, { commandName: snapName });
    } catch (e) {
      errReason = String(e && e.message ? e.message : e);
    }
    if (applied) return { applied: true, how: how, name: snapName, target: target };
    return { applied: false, reason: errReason || "lock-failed" };
  }

  async function acceptLastLayer() {
    const id = lastResultLayerId;
    if (id == null) {
      return { applied: false, reason: "no-result-layer" };
    }
    const c = core();
    const act = action();
    if (!c || !act || !c.executeAsModal) {
      return { applied: false, reason: "no-photoshop" };
    }
    try {
      await c.executeAsModal(async () => {
        const tgt = [{ _ref: "layer", _id: id }];
        try {
          await act.batchPlay([{
            _obj: "rasterizeLayer",
            _target: tgt,
            _options: { dialogOptions: "dontDisplay" }
          }], { synchronousExecution: true });
        } catch (_) {
          await act.batchPlay([{
            _obj: "rasterizeLayer",
            _target: tgt,
            what: { _enum: "rasterizeItem", _value: "layer" },
            _options: { dialogOptions: "dontDisplay" }
          }], { synchronousExecution: true });
        }
        try {
          await act.batchPlay([{
            _obj: "set",
            _target: tgt,
            to: { _obj: "layer", name: "PXD/LS accepted" },
            _options: { dialogOptions: "dontDisplay" }
          }], { synchronousExecution: true });
        } catch (_) {}
      }, { commandName: "PXD/LS accept" });
    } catch (e) {
      return { applied: false, reason: String(e && e.message ? e.message : e) };
    }
    markCardAccepted();
    return { applied: true, kept: true, rasterized: true, layerId: id };
  }

  async function rollbackLastLayer() {
    if (SHARED_STUDIO) throw new Error("请在共享任务记录中撤销，本地旧图层记录不能用于生产撤销");
    if (lastResultLayerId == null) {
      return { applied: false, reason: "no-result-layer" };
    }
    const id = lastResultLayerId;
    await deleteLayerById(id);
    lastResultLayerId = null;
    const card = $("resultCard");
    if (card) card.hidden = true;
    return { applied: true, deleted: id };
  }

  async function deleteLayerById(id) {
    const c = core();
    const act = action();
    if (!c || !act || id == null) throw new Error("无法撤层");
    await c.executeAsModal(async () => {
      await act.batchPlay([{
        _obj: "delete",
        _target: [{ _ref: "layer", _id: id }],
        _options: { dialogOptions: "dontDisplay" }
      }], { synchronousExecution: true });
    }, { commandName: "PXD/LS undo layer", duration: 30 });
  }

  function markCardAccepted() {
    const card = $("resultCard");
    if (!card) return;
    card.hidden = false;
    let stamp = card.querySelector(".accepted-stamp");
    if (!stamp) {
      stamp = document.createElement("div");
      stamp.className = "accepted-stamp";
      card.appendChild(stamp);
    }
    stamp.textContent = "已验收";
  }

  function showResultCard(layerId, summary) {
    const card = $("resultCard");
    if (!card) return;
    card.hidden = false;
    card.innerHTML = "";
    const p = document.createElement("div");
    p.textContent = summary || "完成";
    card.appendChild(p);
    if (layerId == null) {
      const w = document.createElement("div");
      w.className = "warn";
      w.textContent = "本层未回读，不能对文档撤";
      card.appendChild(w);
    } else {
      const btn = ui.createButton("result-undo", "撤这层");
      btn.addEventListener("click", async () => {
        try {
          await rollbackLastLayer();
          log("已撤层 " + layerId, "ok");
          card.hidden = true;
        } catch (e) {
          log("撤层失败: " + (e && e.message || e), "err");
        }
      });
      card.appendChild(btn);
    }
  }

  /* ---- Companion ---- */

  async function post(path, body) {
    if (SHARED_STUDIO) throw new Error("旧版模拟执行入口已停用，请使用专业工作区的共享草稿");
    const r = await fetch(baseUrl() + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    const text = await r.text();
    try {
      return JSON.parse(text);
    } catch (_) {
      return { ok: false, raw: text, status: r.status };
    }
  }

  function hideEmptyChips() {
    const el = $("emptyChips");
    if (el) el.hidden = true;
  }

  async function runPipeline(text, opts) {
    if (SHARED_STUDIO) {
      if (!window.PXD_STUDIO || !window.PXD_STUDIO.controller) throw new Error("共享专业工作区尚未加载，未执行旧版模拟流程");
      await window.PXD_STUDIO.controller.loadRecipe({ prompt: String(text || "") });
      showTab("pro");
      return; // Legacy controls may stage a shared draft, never run a mock pipeline.
    }
    hideEmptyChips();
    if ($("resultCard")) $("resultCard").hidden = true;
    opts = opts || {};
    if (opts.pinnedCapture && captureUsable(opts.pinnedCapture)) {
      lastCapture = opts.pinnedCapture;
    }
    if (!text || !String(text).trim()) {
      log("说一下要改什么。", "err");
      showResultCard(null, "没有指令");
      return;
    }

    const rec = {
      ts: Date.now(),
      text: String(text),
      recipeId: loadedRecipeId,
      selectionWh: "",
      reusedCapture: false,
      generated: false,
      reason: "",
      capture: null
    };
    let lastApplyRes = null;
    let earlyReason = "";
    let runCap = lastCapture;
    const capAtStart = lastCapture;
    let lastLayerId = null;
    let didWrite = false;
    let faceBoxMock = false;
    let usedFaceBox = false;

    function pinActive() {
      return !!(opts.pinnedCapture && captureUsable(opts.pinnedCapture));
    }
    async function capForThisRun(liveSel) {
      if (pinActive()) {
        lastCapture = opts.pinnedCapture;
        log("抓图：复用选区 " + (lastCapture.selection && lastCapture.selection.width) + "x" + (lastCapture.selection && lastCapture.selection.height), "ok");
        showThumb96(lastCapture.base64);
        return lastCapture;
      }
      return reuseOrRecapture(liveSel);
    }
    function fillRec() {
      rec.capture = snapshotCapture(runCap || lastCapture);
      const sel = rec.capture && rec.capture.selection;
      rec.selectionWh = (sel && sel.width != null && sel.height != null) ? (sel.width + "×" + sel.height) : "";
      rec.reusedCapture = pinActive() || (captureUsable(runCap) && runCap === capAtStart);
      rec.generated = !!(lastApplyRes && lastApplyRes.generated);
      rec.reason = lastApplyRes ? (lastApplyRes.reason || "no banana key") : (earlyReason || "no banana key");
      rec.recipeId = loadedRecipeId;
    }

    try {
    let doc = await readDocumentState();
    log(doc.open ? ("文档 " + doc.name) : "没有打开的文档", "ok");
    const compileRes = await post("/compile", {
      text: text,
      recipeId: loadedRecipeId,
      document: doc,
      selScope: selScope(),
      selection: doc.selection,
    });
    const planRes = compileRes && compileRes.plan
      ? compileRes
      : await post("/plan", { text: text, recipeId: loadedRecipeId, document: doc, selScope: selScope(), selection: doc.selection });
    if (planIsRefused(planRes)) {
      const reason = planRefuseReason(planRes);
      earlyReason = reason;
      log(reason, "err");
      showResultCard(null, reason);
      return;
    }
    const planObj = planRes.plan || {};
    if (planObj.refuse) {
      const reason = planObj.reason || "无法按生成默认提亮";
      earlyReason = reason;
      log(reason, "err");
      showResultCard(null, reason);
      return;
    }
    log(planObj.intentLabel || "COS 形计划", "ok");

    const steps = planObj.steps || [];

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (step.kind === "lock") {
        const locked = await applyLockInPs(step);
        if (locked && locked.applied) {
          log("锁：" + (step.target || "皮肤质感") + " · " + (locked.how || "ps"), "ok");
        } else {
          const reason = (locked && locked.reason) || "lock-failed";
          log("锁未落地: " + reason, "err");
          showResultCard(null, "锁未落地: " + reason);
        }
        continue;
      }
      if (step.kind === "accept") {
        const acc = await acceptLastLayer();
        if (acc && acc.applied) {
          log("接受预览 · 保留层 " + acc.layerId, "ok");
          showResultCard(acc.layerId, "已验收");
          markCardAccepted();
        } else {
          const reason = (acc && acc.reason) || "no-result-layer";
          log("接受失败: " + reason, "err");
          showResultCard(null, "接受失败: " + reason);
        }
        continue;
      }
      if (step.kind === "rollback") {
        try {
          const rb = await rollbackLastLayer();
          if (rb && rb.applied) {
            log("回滚：已删层 " + rb.deleted, "ok");
            showResultCard(null, "已回滚");
          } else {
            const reason = (rb && rb.reason) || "no-result-layer";
            log("回滚失败: " + reason, "err");
            showResultCard(null, "回滚失败: " + reason);
          }
        } catch (re) {
          log("回滚失败: " + (re && re.message || re), "err");
          showResultCard(null, "回滚失败");
        }
        continue;
      }
      if (isRecipeEditStep(step)) {
        log("编辑：" + (step.skill || "配方") + "（非提亮原子）", "ok");
        continue;
      }
      if (step.atom === "face-box") {
        const box = await post("/atom/face-box", { document: doc });
        usedFaceBox = true;
        const mockFace = faceBoxIsMock(box);
        if (mockFace) {
          faceBoxMock = true;
          log("框脸：模拟不是检测", "err");
        } else {
          log("框脸：检测", "ok");
        }
        const liveSel = await readSelectionBounds();
        /* Mock face-box is not a detection. Never selectFaceBox / capture fake centered bounds. */
        if (mockFace) {
          try {
            runCap = await capForThisRun(liveSel);
          } catch (ce) {
            const cm = String(ce && ce.message ? ce.message : ce);
            if (cm.indexOf("NO_SELECTION") !== -1 && captureUsable(lastCapture)) {
              runCap = lastCapture;
              log("抓图：复用选区 " + (runCap.selection && runCap.selection.width) + "x" + (runCap.selection && runCap.selection.height), "ok");
              showThumb96(runCap.base64);
            } else {
              log(cm.indexOf("NO_SELECTION") !== -1 ? "NO_SELECTION" : ("抓图失败: " + cm), "err");
              if (cm.indexOf("NO_SELECTION") !== -1) throw ce;
            }
          }
        } else if (pinActive()) {
          runCap = await capForThisRun(liveSel);
        } else if (captureUsable(lastCapture) && !userMadeNewSelection(liveSel, lastCapture)) {
          runCap = lastCapture;
          log("抓图：复用选区 " + (runCap.selection && runCap.selection.width) + "x" + (runCap.selection && runCap.selection.height), "ok");
          showThumb96(runCap.base64);
        } else if (captureUsable(lastCapture) && userMadeNewSelection(liveSel, lastCapture)) {
          runCap = await reuseOrRecapture(liveSel);
        } else {
          if (box.bounds) await selectFaceBox(box.bounds);
          try {
            runCap = await psCapture(box.bounds || undefined);
            lastCapture = runCap;
            log("抓图：选区 " + (runCap.selection && runCap.selection.width) + "x" + (runCap.selection && runCap.selection.height), "ok");
          } catch (ce) {
            const cm = String(ce && ce.message ? ce.message : ce);
            if (cm.indexOf("NO_SELECTION") !== -1 && captureUsable(lastCapture)) {
              runCap = lastCapture;
              log("抓图：复用选区 " + (runCap.selection && runCap.selection.width) + "x" + (runCap.selection && runCap.selection.height), "ok");
              showThumb96(runCap.base64);
            } else {
              log(cm.indexOf("NO_SELECTION") !== -1 ? "NO_SELECTION" : ("抓图失败: " + cm), "err");
              if (cm.indexOf("NO_SELECTION") !== -1) throw ce;
            }
          }
        }
        doc = await readDocumentState();
        continue;
      }
      if (isBrightenStep(step)) {
        doc = await readDocumentState();
        const liveSel = doc.selection;
        try {
          if (pinActive()) {
            runCap = await capForThisRun(liveSel);
          } else if (!captureUsable(runCap) || userMadeNewSelection(liveSel, runCap)) {
            runCap = await reuseOrRecapture(liveSel);
          } else if (captureUsable(runCap)) {
            log("抓图：复用选区 " + (runCap.selection && runCap.selection.width) + "x" + (runCap.selection && runCap.selection.height), "ok");
            showThumb96(runCap.base64);
          }
        } catch (ce) {
          const cm = String(ce && ce.message ? ce.message : ce);
          if (cm.indexOf("NO_SELECTION") !== -1 && !captureUsable(lastCapture)) throw ce;
          if (captureUsable(lastCapture)) runCap = lastCapture;
        }
        const reused = captureUsable(runCap) && runCap === capAtStart;
        const gradeSel = (runCap && runCap.selection) || liveSel;
        const hasSelection = !!(gradeSel && gradeSel.left != null);
        let imgB64 = null;
        if (runCap && runCap.base64) {
          const applyBody = buildApplyBody(runCap, text, doc, reused || pinActive());
          const appliedPx = await post("/apply", applyBody);
          lastApplyRes = appliedPx;
          imgB64 = pickImageB64(appliedPx);
          if (imgB64) {
            if (applyIsMock(appliedPx)) log(MOCK_VENDOR_LABEL, "err");
          } else if (appliedPx && !appliedPx.generated) {
            log(appliedPx.reason || "no banana key", "err");
          }
        }
        const br = await post("/atom/brighten", {
          document: doc,
          selection: gradeSel,
          hasSelection: hasSelection,
          plan: step,
          capture: runCap ? { selection: runCap.selection, width: runCap.width, height: runCap.height } : null,
        });
        const cachedSel = lastCapture && lastCapture.selection;
        if (imgB64) {
          log(hasSelection ? "提亮：按选区蒙版" : "回贴像素", "ok");
        } else if (cachedSel) {
          log("提亮：按选区蒙版", "ok");
        } else {
          log("无像素不回退全图", "err");
        }
        if (br && br.instruction) log(br.instruction, "ok");
        if (!imgB64) imgB64 = pickImageB64(br);
        let applied = null;
        if (imgB64) {
          /* Mock or real pixels: returnAlign only. Never applyBrightenInPs after pixels. */
          applied = await returnAlign(imgB64, {
            selection: (runCap && runCap.selection) || liveSel,
            docId: runCap && runCap.docId,
            layerType: "smartObject",
            groupName: "PXD/LS",
            maskFromSelection: selScope() === "scope"
          });
          log("回贴：placeEvent 对齐选区", "ok");
        } else if (!cachedSel) {
          /* /apply without pixels and no lastCapture.selection: skip write. */
        } else if (planObj.refuse) {
          /* refuse: never applyBrighten */
        } else if (!loadedRecipeId && !isIgnoreScope() && shouldApplyBrighten(planObj)) {
          applied = await applyBrightenInPs(step);
        }
        lastLayerId = applied && applied.layerId != null ? applied.layerId : null;
        if (lastLayerId != null) lastResultLayerId = lastLayerId;
        didWrite = !!(applied && applied.applied);
        continue;
      }
      if (isMaskStep(step)) {
        doc = await readDocumentState();
        const liveSel = doc.selection || (await readSelectionBounds());
        const cachedSel = (runCap && runCap.selection) || (lastCapture && lastCapture.selection);
        const sel = liveSel || cachedSel;
        const hasSelection = !!(sel && sel.left != null && (sel.width > 0 || (sel.right - sel.left) > 0));
        await post("/atom/mask", {
          document: doc,
          selection: sel,
          hasSelection: hasSelection,
          from: "selection",
          layerId: lastResultLayerId
        });
        /* Apply after face-box/brighten so last returned layer (or a new adj) gets the user mask. */
        const masked = await applyMaskFromSelection({ selection: sel, layerId: lastResultLayerId });
        if (masked && masked.applied) {
          log("蒙版：选区 revealSelection", "ok");
          lastLayerId = masked.layerId != null ? masked.layerId : lastLayerId;
          if (lastLayerId != null) lastResultLayerId = lastLayerId;
          didWrite = true;
        } else {
          const reason = (masked && masked.reason) || "mask-failed";
          log("蒙版未落地: " + reason, "err");
          showResultCard(null, "蒙版未落地: " + reason);
        }
        continue;
      }
      if (isFxStep(step)) {
        await post("/atom/fx", {
          document: doc,
          fx: step.fx || "outerGlow",
          layerId: lastResultLayerId
        });
        const fxed = await applyFxInPs({ fx: step.fx || "outerGlow", layerId: lastResultLayerId });
        if (fxed && fxed.applied) {
          log("特效：outerGlow layerEffects", "ok");
          lastLayerId = fxed.layerId != null ? fxed.layerId : lastLayerId;
          if (lastLayerId != null) lastResultLayerId = lastLayerId;
          didWrite = true;
        } else {
          const reason = (fxed && fxed.reason) || "fx-failed";
          log("特效未落地: " + reason, "err");
          showResultCard(null, "特效未落地: " + reason);
        }
        continue;
      }
      if (isGradeStep(step)) {
        doc = await readDocumentState();
        const cachedSel = (runCap && runCap.selection) || (lastCapture && lastCapture.selection);
        const hasSelection = !!(cachedSel && cachedSel.left != null && (cachedSel.width > 0 || (cachedSel.right - cachedSel.left) > 0));
        await post("/atom/grade", {
          document: doc,
          selection: cachedSel,
          hasSelection: hasSelection,
          tool: step.tool || "hue-sat"
        });
        const graded = await applyGradeInPs({ selection: cachedSel });
        if (graded && graded.applied) {
          log("调色：hue-sat 选区", "ok");
          lastLayerId = graded.layerId != null ? graded.layerId : lastLayerId;
          if (lastLayerId != null) lastResultLayerId = lastLayerId;
          didWrite = true;
        } else {
          const reason = (graded && graded.reason) || "grade-failed";
          log("调色未落地: " + reason, "err");
          showResultCard(null, "调色未落地: " + reason);
        }
        continue;
      }
      if (isAdjustLayerStep(step)) {
        doc = await readDocumentState();
        const cachedSel = (runCap && runCap.selection) || (lastCapture && lastCapture.selection);
        const hasSelection = !!(cachedSel && cachedSel.left != null && (cachedSel.width > 0 || (cachedSel.right - cachedSel.left) > 0));
        await post("/atom/adjust-layer", {
          document: doc,
          selection: cachedSel,
          hasSelection: hasSelection,
          tool: step.tool || "curves-or-levels"
        });
        const adj = await applyAdjustLayerInPs({ selection: cachedSel, tool: step.tool });
        if (adj && adj.applied) {
          log("调整层：curves-or-levels 选区", "ok");
          lastLayerId = adj.layerId != null ? adj.layerId : lastLayerId;
          if (lastLayerId != null) lastResultLayerId = lastLayerId;
          didWrite = true;
        } else {
          const reason = (adj && adj.reason) || "NO_SELECTION";
          log("调整层未落地: " + reason, "err");
          showResultCard(null, "调整层未落地: " + reason);
        }
        continue;
      }
      if (isSelectStep(step)) {
        const cachedSel = lastCapture && lastCapture.selection;
        const hasSelection = !!(cachedSel && cachedSel.left != null && (cachedSel.width > 0 || (cachedSel.right - cachedSel.left) > 0));
        await post("/atom/select", {
          document: doc,
          selection: cachedSel,
          hasSelection: hasSelection
        });
        const selected = await applySelectInPs();
        if (selected && selected.applied) {
          log("选区：恢复 lastCapture.selection", "ok");
          didWrite = true;
        } else {
          const reason = (selected && selected.reason) || "NO_SELECTION";
          log("选区未落地: " + reason, "err");
          showResultCard(null, "选区未落地: " + reason);
        }
        continue;
      }
      if (isReadbackStep(step)) {
        const snap = await readbackSnapshot();
        const rb = await post("/atom/readback", {
          document: snap && snap.document ? Object.assign({}, snap.document, { open: true, layer: snap.layer && snap.layer.name, layerId: snap.layer && snap.layer.id, selection: snap.selection }) : null,
          layer: snap && snap.layer,
          selection: snap && snap.selection,
          host: !!(snap && snap.ok)
        });
        if (snap && snap.ok) {
          log("读回：文档/层/选区快照", "ok");
          showResultCard(snap.layer && snap.layer.id != null ? snap.layer.id : null, "已读回");
        } else {
          const reason = (snap && snap.reason) || (rb && rb.reason) || "HOST_MISSING";
          log("读回失败: " + reason, "err");
          showResultCard(null, "读回失败: " + reason);
        }
        continue;
      }
    }

    const wantPixels = !!loadedRecipeId && !lastApplyRes;
    if (wantPixels && compileRes && !compileRes.refuse && !didWrite) {
      let cap = runCap;
      if (pinActive()) {
        cap = await capForThisRun(doc.selection);
        lastCapture = cap;
        runCap = cap;
      } else if (!captureUsable(cap) || userMadeNewSelection(doc.selection, cap)) {
        try {
          cap = await reuseOrRecapture(doc.selection);
          lastCapture = cap;
          runCap = cap;
        } catch (ce) {
          const msg = String(ce && ce.message || ce);
          if (msg.indexOf("NO_SELECTION") >= 0 && !captureUsable(lastCapture)) throw ce;
          if (msg.indexOf("NO_SELECTION") < 0) log("抓图失败: " + msg, "err");
          cap = captureUsable(lastCapture) ? lastCapture : null;
        }
      } else if (captureUsable(cap)) {
        log("已复用选区 " + (cap.width || (cap.selection && cap.selection.width)) + "x" + (cap.height || (cap.selection && cap.selection.height)), "ok");
      }
      const reusedApply = captureUsable(cap) && cap === capAtStart;
      if (cap && cap.base64) {
        if (!reusedApply) {
          log("已抓选区 " + (cap.width || (cap.selection && cap.selection.width)) + "x" + (cap.height || (cap.selection && cap.selection.height)), "ok");
        }
        const applyBody = buildApplyBody(cap, compileRes.prompt || text, doc, reusedApply || pinActive());
        const applied = await post("/apply", applyBody);
        lastApplyRes = applied;
        const px = pickImageB64(applied);
        if (px) {
          if (applyIsMock(applied)) log(MOCK_VENDOR_LABEL, "err");
          const placed = await returnAlign(px, {
            selection: cap.selection,
            docId: cap.docId,
            layerType: "smartObject",
            groupName: "PXD/LS",
            maskFromSelection: selScope() === "scope" && cap.usedSelection,
          });
          lastLayerId = placed && placed.layerId != null ? placed.layerId : lastLayerId;
          if (lastLayerId != null) lastResultLayerId = lastLayerId;
          didWrite = !!(placed && placed.applied);
        } else {
          log((applied && applied.reason) || "no banana key", "err");
        }
      } else if (!cap) {
        log("抓图不可用（需 PS imaging.getPixels）", "err");
      }
    }

    const mockBits = [];
    if (usedFaceBox && faceBoxMock) mockBits.push("模拟不是检测");
    if (applyIsMock(lastApplyRes)) mockBits.push(MOCK_VENDOR_LABEL);
    const mockLine = mockBits.join(" · ");
    function cardText(base) {
      if (mockLine && base) return mockLine + " · " + base;
      return mockLine || base;
    }
    if (didWrite) {
      showResultCard(lastLayerId, cardText("已尝试落地"));
    } else if (steps.length) {
      showResultCard(null, cardText("本层未回读，不能对文档撤"));
    } else {
      showResultCard(null, cardText("没有可执行步骤"));
    }
    } catch (e) {
      earlyReason = String(e && e.message ? e.message : e);
      throw e;
    } finally {
      fillRec();
      pushRecord(rec);
    }
  }

  /* ---- UI ---- */

  function applyTheme(t) {
    const light = t === "light";
    document.documentElement.setAttribute("data-theme", light ? "light" : "dark");
    const app = $("app");
    if (app) {
      app.classList.toggle("theme-light", light);
      app.classList.toggle("theme-dark", !light);
    }
    const tl = $("themeLight");
    if (tl) tl.checked = light;
    const labDark = $("labDark");
    const labLight = $("labLight");
    if (labDark) labDark.classList.toggle("on", !light);
    if (labLight) labLight.classList.toggle("on", light);
    try { localStorage.setItem("pxd-theme", light ? "light" : "dark"); } catch (_) {}
  }

  function syncJsonGate() {
    const app = $("app");
    if (app) app.classList.toggle("show-json", gateOn("swJson"));
  }

  let lastPanelWidth = -1;
  function markWide() {
    const app = $("app");
    if (!app) return;
    const w = ((app.getBoundingClientRect && app.getBoundingClientRect().width) || document.body.clientWidth || 360) / (window.PXD_SCALE ? window.PXD_SCALE.factor() : 1);
    if (w === lastPanelWidth) return;
    lastPanelWidth = w;
    app.classList.toggle("wide", w >= 520);
    app.classList.toggle("compact", w < 320);
    try { window.dispatchEvent(new Event("pxd-layout-change")); } catch (_) {}
  }

  function showTab(id) {
    document.querySelectorAll(".tab").forEach((b) => {
      const on = b.getAttribute("data-tab") === id;
      b.classList.toggle("is-on", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
      b.setAttribute("tabindex", on ? "0" : "-1");
    });
    document.querySelectorAll(".pane").forEach((p) => {
      const on = p.id === "pane-" + id;
      p.classList.toggle("is-on", on);
      if (on) p.removeAttribute("hidden");
      else p.setAttribute("hidden", "");
    });
    markWide();
    if (id === "pro") {
      if (SHARED_STUDIO) { if (window.PXD_STUDIO && window.PXD_STUDIO.controller) window.PXD_STUDIO.controller.refresh().catch(function () {}); }
      else { refreshJob(); searchRecipes(); }
    }
  }

  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      showTab(btn.getAttribute("data-tab"));
    });
    btn.addEventListener("keydown", (event) => {
      const tabs = Array.from(document.querySelectorAll(".tab"));
      let target = btn;
      if (event.key === "ArrowRight") target = tabs[(tabs.indexOf(btn) + 1) % tabs.length];
      else if (event.key === "ArrowLeft") target = tabs[(tabs.indexOf(btn) + tabs.length - 1) % tabs.length];
      else if (event.key === "Home") target = tabs[0];
      else if (event.key === "End") target = tabs[tabs.length - 1];
      else if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      showTab(target.getAttribute("data-tab"));
      target.focus();
    });
  });

  const healthDot = $("healthDot");
  function goSettings() { showTab("settings"); }
  if (healthDot) {
    healthDot.addEventListener("click", goSettings);
    healthDot.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        goSettings();
      }
    });
  }
  const statusEl = document.querySelector(".comp") || document.querySelector(".status");
  if (statusEl) statusEl.addEventListener("click", goSettings);


  document.querySelectorAll("#selChips .chip, #proSelChips .chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      const wasOn = btn.classList.contains("is-on");
      const sel = btn.getAttribute("data-sel");
      setSelScope(sel);
      if (sel === "ref" && wasOn) {
        const picker = $("refFile");
        if (picker) { delete picker.dataset.slot; picker.click(); }
      }
    });
  });

  const refFile = $("refFile");
  if (refFile) {
    refFile.addEventListener("change", async function () {
      const slot = refFile.dataset.slot;
      if (slot != null && slot !== "") {
        const files = refFile.files;
        if (files && files[0]) {
          try {
            const du = await readFileAsDataUrl(files[0]);
            const b64 = await shrinkDataUrl(du);
            if (b64) {
              const rec = { base64: b64, dataUrl: "data:image/jpeg;base64," + b64 };
              const i = Math.max(0, Math.min(3, Number(slot)));
              attachedRefs[i] = rec;
              if (attachedRefs.length > MAX_REFS) attachedRefs.length = MAX_REFS;
              setRefNote("");
              renderRefThumbs();
              post("/job/context", { refs: attachedRefs.map(function (_, n) { return { id: ["A","B","C","D"][n], on: !!attachedRefs[n] }; }) });
            }
          } catch (_) {}
        }
      } else {
        addRefFiles(refFile.files);
      }
      try { refFile.value = ""; delete refFile.dataset.slot; } catch (_) {}
    });
  }
  function onPasteImages(e) {
    const cd = e.clipboardData;
    if (!cd) return;
    const files = [];
    if (cd.files && cd.files.length) {
      for (let i = 0; i < cd.files.length; i++) files.push(cd.files[i]);
    } else if (cd.items) {
      for (let i = 0; i < cd.items.length; i++) {
        const it = cd.items[i];
        if (it && it.kind === "file" && it.type && it.type.indexOf("image/") === 0) {
          const f = it.getAsFile && it.getAsFile();
          if (f) files.push(f);
        }
      }
    }
    if (!files.length) return;
    e.preventDefault();
    addRefFiles(files);
  }
  const composerEl = document.querySelector(".composer");
  document.querySelectorAll("#pane-pro .composer").forEach(function (el) { el.addEventListener("paste", onPasteImages); });

  $("readDoc").addEventListener("click", async () => {
    const st = await readDocumentState();
    $("docDump").textContent = st.open ? (st.name + (st.layer ? " / " + st.layer : "")) : "没有打开的文档";
  });

  const recipeQ = $("recipeQ");
  const recipeHits = $("recipeHits");

  function showJsonOn() {
    return gateOn("swJson");
  }

  function paintJobParams(params) {
    const box = $("params");
    if (!box) return;
    box.innerHTML = "";
    if (!params || !params.length) return;
    params.slice(0, 3).forEach(function (prm) {
      const row = document.createElement("div");
      row.className = "param";
      const lab = document.createElement("label");
      lab.className = "param-label";
      const name = document.createElement("span");
      name.textContent = prm.label || prm.id;
      const val = document.createElement("span");
      val.className = "param-val";
      val.textContent = String(prm.value);
      lab.appendChild(name);
      lab.appendChild(val);
      if (showJsonOn()) {
        const key = document.createElement("em");
        key.textContent = prm.key || ("@param:" + prm.id);
        lab.appendChild(key);
      }
      const inp = document.createElement("input");
      inp.type = "range";
      inp.min = prm.min != null ? String(prm.min) : "0";
      inp.max = prm.max != null ? String(prm.max) : "1";
      inp.step = prm.step != null ? String(prm.step) : "0.1";
      inp.value = String(prm.value);
      inp.setAttribute("data-param-id", prm.id);
      inp.addEventListener("change", async function () {
        val.textContent = inp.value;
        const values = {};
        box.querySelectorAll("input[data-param-id]").forEach(function (el) {
          values[el.getAttribute("data-param-id")] = Number(el.value);
        });
        try {
          await post("/job/params", { recipeId: loadedRecipeId, values: values });
          await refreshJob();
        } catch (e) {
          log(String(e && e.message ? e.message : e), "err");
        }
      });
      row.appendChild(lab);
      row.appendChild(inp);
      if (prm.desc && showJsonOn()) {
        const d = document.createElement("div");
        d.className = "param-desc";
        d.textContent = prm.desc;
        row.appendChild(d);
      }
      box.appendChild(row);
    });
  }

  function applyJobToUi(j) {
    if (!j) return;
    const job = j.job || j;
    const instruction = j.instruction || (job && job.instruction) || {};
    const params = j.params || (job && job.params) || [];
    const compile = $("compile");
    if (compile) {
      if (job && job.loaded && instruction.executionText) {
        compile.value = instruction.executionText;
      } else if (!(job && job.loaded)) {
        compile.value = "";
        compile.placeholder = "点资料里的配方写入";
      }
    }
    const ctx = j.context || (job && job.context) || {};
    const lineBits = [];
    if (ctx.document && ctx.document.name) lineBits.push(String(ctx.document.name));
    if (ctx.document && ctx.document.width && ctx.document.height) {
      lineBits.push(ctx.document.width + "×" + ctx.document.height);
    }
    if (ctx.selection && (ctx.selection.width || ctx.selection.right != null)) {
      const sel = ctx.selection;
      const w = sel.width != null ? sel.width : (sel.right - sel.left);
      const h = sel.height != null ? sel.height : (sel.bottom - sel.top);
      lineBits.push("选区 " + w + "×" + h);
    }
    const line = lineBits.join(" · ");
    const dump = $("docDump");
    const ctxLine = $("ctxLine");
    if (ctxLine) ctxLine.textContent = line;
    if (dump && line) dump.textContent = line;
    if (job && job.loaded) {
      loadedRecipeId = instruction.recipeId || loadedRecipeId;
      paintJobParams(params);
    } else {
      paintJobParams([]);
    }
  }

  async function refreshJob() {
    if (SHARED_STUDIO) return;
    try {
      const r = await fetch(baseUrl() + "/job");
      const j = await r.json();
      applyJobToUi(j);
    } catch (_) {}
  }

  async function searchRecipes() {
    if (SHARED_STUDIO) return;
    if (!recipeHits) return;
    const q = recipeQ ? recipeQ.value.trim() : "";
    const r = await fetch(baseUrl() + "/recipes?q=" + encodeURIComponent(q) + "&region=&limit=8");
    const j = await r.json();
    recipeHits.innerHTML = "";
    const items = j.items || [];
    items.forEach((it) => {
      const b = document.createElement("div");
      b.className = "recipe-row";
      b.innerHTML = (it.title || it.id || "") + "<em>" + (it.region || it.tag || it.p || "recipe") + (it.hasParams ? " · 可调" : "") + "</em>";
      b.addEventListener("click", async () => {
        const loaded = await post("/recipes/" + encodeURIComponent(it.id) + "/load", { text: ($("proTa") && $("proTa").value) || $("prompt").value });
        loadedRecipeId = it.id;
        log("已装入 " + it.title + "，下一步 /plan（COS 形，非自动提亮）", "ok");
        document.querySelectorAll(".recipe-row").forEach((x) => x.classList.remove("is-on"));
        b.classList.add("is-on");
        await refreshJob();
        if ($("proTa") && it.title) $("proTa").value = it.title;
        updatePrimaryLabel();
        if (loaded && loaded.execution) {
          /* constraint only; do not treat as COS or brighten */
        }
      });
      recipeHits.appendChild(b);
    });
  }
  if (recipeQ) {
    let t = null;
    recipeQ.addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(searchRecipes, 200);
    });
  }
  if ($("libToggle")) {
    $("libToggle").addEventListener("click", function () {
      if (recipeQ) recipeQ.focus();
    });
  }
  searchRecipes();

  if ($("themeLight")) {
    $("themeLight").addEventListener("change", (e) => applyTheme(e.target.checked ? "light" : "dark"));
  }
  if ($("labDark")) $("labDark").addEventListener("click", function () { applyTheme("dark"); });
  if ($("labLight")) $("labLight").addEventListener("click", function () { applyTheme("light"); });
  document.querySelectorAll("#swBatch,#swBrush,#swJson,#swConfirm,#swGroup,#swAuto").forEach(function (el) {
    el.addEventListener("click", function () {
      el.classList.toggle("on");
      if (el.id === "swJson") { syncJsonGate(); refreshJob(); }
    });
  });
  document.querySelectorAll("#proRefs i").forEach(function (el, idx) {
    el.addEventListener("click", function () {
      const picker = $("refFile");
      if (!picker) return;
      picker.dataset.slot = String(idx);
      picker.click();
    });
  });
  document.querySelectorAll("input[name=defRet]").forEach(function (r) {
    r.parentElement.addEventListener("pxd-radio-change", function () {
      const map = { layer: 0, so: 1 };
      const i = map[r.value];
      const rets = document.querySelectorAll("input[name=ret]");
      if (i !== undefined) rets.forEach(function (ret, index) { ret.checked = index === i; });
      ui.syncRadios();
    });
  });
  if ($("compRetry")) $("compRetry").addEventListener("click", function () { pingHealth(); });
  if ($("toAgent")) {
    $("toAgent").addEventListener("click", function () {
      if (SHARED_STUDIO) { if (window.PXD_STUDIO) window.PXD_STUDIO.toAgent(); return; }
      showTab("agent");
      const compile = $("compile");
      if (compile && compile.value) $("prompt").value = compile.value;
      $("prompt").focus();
    });
  }
  if ($("proTa")) $("proTa").addEventListener("input", updatePrimaryLabel);
  if ($("applyBtn")) {
    $("applyBtn").addEventListener("click", async function () {
      if (SHARED_STUDIO) {
        try { await runPipeline(($("proTa") && $("proTa").value) || ($("compile") && $("compile").value) || ""); }
        catch (e) { log(String(e && e.message ? e.message : e), "err"); }
        return;
      }
      if (ui.isDisabled($("applyBtn"))) return;
      if (document.querySelector("input[name=ret][value=cover]") &&
          document.querySelector("input[name=ret][value=cover]").checked &&
          gateOn("swConfirm")) {
        try {
          if (typeof confirm === "function" && !confirm("覆盖当前层？此操作需二次确认。")) return;
        } catch (_) {}
      }
      if (!gateOn("swBatch") && /batch|批处理/.test(($("proTa") && $("proTa").value) || "")) {
        log("批处理闸关闭", "err");
        return;
      }
      const text = (($("proTa") && $("proTa").value.trim()) || ($("compile") && $("compile").value.trim()) || ($("prompt") && $("prompt").value.trim()));
      if ($("prompt") && text) $("prompt").value = text;
      try { await runPipeline(text); } catch (e) { log(String(e && e.message ? e.message : e), "err"); }
    });
  }
  try {
    applyTheme(localStorage.getItem("pxd-theme") || "dark");
  } catch (_) { applyTheme("dark"); }
  syncJsonGate();
  markWide();
  window.addEventListener("resize", markWide);
  window.addEventListener("pxd-scale-change", markWide);
  let sizeObserver = null;
  if (typeof ResizeObserver !== "undefined") {
    try {
      sizeObserver = new ResizeObserver(markWide);
      sizeObserver.observe($("app") || document.body);
    } catch (_) { sizeObserver = null; }
  }
  // UXP 8 has no ResizeObserver and panel resizing may omit window.resize.
  // Measure one node only; markWide mutates the DOM only when its width changes.
  const sizeTimer = sizeObserver ? null : setInterval(markWide, 250);
  window.addEventListener("unload", function () {
    if (sizeObserver) sizeObserver.disconnect();
    if (sizeTimer) clearInterval(sizeTimer);
    window.removeEventListener("resize", markWide);
  });

  setConnected(false);
  updatePrimaryLabel();
  if (!SHARED_STUDIO) try {
    const restored = restoreLastCapture();
    if (captureUsable(restored)) {
      lastCapture = restored;
      showThumb96(restored.base64);
    } else {
      lastCapture = null;
    }
  } catch (_) {
    lastCapture = null;
  }
  if (!SHARED_STUDIO) try {
    const recs = restoreRecords();
    if (recs && recs.length) {
      taskRecords = recs;
      renderRecords();
    }
  } catch (_) {}
  pingHealth();
  setInterval(pingHealth, 4000);

  window.PXD_CONTEXT = {
    isPhotoshop: !!ps(),
    read: readDocumentState,
    captureSelection: async function () {
      if (!hostPs.capture) throw new Error("请在 Photoshop 中附上选区图");
      return hostPs.capture();
    }
  };
  window.PXD_NAV = { showTab: showTab, baseUrl: baseUrl };
  if (SHARED_STUDIO) {
    ["proRow", "proComposer"].forEach(function (id) { const el = $(id); if (el) { el.hidden = true; el.style.display = "none"; } });
    // These Alpha-only switches do not represent the current shared draft.
    ["swConfirm", "swGroup", "swAuto", "swBatch", "swBrush", "swJson"].forEach(function (id) { const el = $(id); if (el && el.parentElement) el.parentElement.hidden = true; });
    document.querySelectorAll("input[name=defRet]").forEach(function (el) { if (el.parentElement && el.parentElement.parentElement && el.parentElement.parentElement.parentElement) el.parentElement.parentElement.parentElement.hidden = true; });
  }

})();
