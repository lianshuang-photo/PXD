"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { createAgentHttp } = require("./agent-http");
const agentHttp = createAgentHttp();
const PORT = Number(process.env.PXDLS_PORT || 17880);
const HOST = process.env.PXDLS_HOST || "127.0.0.1";
const STARTED_AT = new Date().toISOString();
const FACTORY_DIR = process.env.PXDLS_FACTORY_PRESETS ||
  path.join(__dirname, "factory_presets");

const REGION_TO_CATEGORY = {
  face: "head",
  hair: "hair",
  neck: "neck",
  body: "torso",
  arms: "arms",
  hands: "hands",
  legs: "legs",
  feet: "feet",
  clothes: "clothing",
  prop: "accessory",
  full: "fullbody",
  bg: "background",
  light: "lighting",
  head: "head",
  torso: "torso",
  clothing: "clothing",
  accessory: "accessory",
  fullbody: "fullbody",
  background: "background",
  lighting: "lighting",
};

const CATEGORY_TO_REGION = {
  head: "face",
  hair: "hair",
  neck: "neck",
  torso: "body",
  arms: "arms",
  hands: "hands",
  legs: "legs",
  feet: "feet",
  clothing: "clothes",
  accessory: "prop",
  fullbody: "full",
  background: "bg",
  lighting: "light",
};

let lastApplyMeta = null;
let lastLoaded = null;
let factoryCache = null;
let lastJob = {
  recipeId: null,
  title: "",
  executionText: "",
  userText: "",
  params: [],
  context: { document: null, selection: null, refs: [] },
  loaded: false,
};

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function parseContentJson(content) {
  try {
    return JSON.parse(String(content || ""));
  } catch (_) {
    return null;
  }
}

function parseParamsFromContent(content) {
  const j = parseContentJson(content);
  if (!j || typeof j !== "object") return [];
  const params = [];
  Object.keys(j).forEach(function (k) {
    const m = /^@param:(.+)$/.exec(k);
    if (!m) return;
    const name = m[1];
    if (name.slice(-5) === "_desc") return;
    const raw = j[k];
    const num = typeof raw === "number" ? raw : Number(raw);
    params.push({
      id: name,
      key: k,
      label: name,
      value: Number.isFinite(num) ? num : 0,
      min: 0,
      max: 1,
      step: 0.1,
      desc: j["@param:" + name + "_desc"] != null ? String(j["@param:" + name + "_desc"]) : "",
    });
  });
  return params;
}

function applyParamValues(content, values) {
  const j = parseContentJson(content);
  if (!j) return content;
  const vals = values || {};
  Object.keys(vals).forEach(function (id) {
    const key = String(id).indexOf("@param:") === 0 ? String(id) : ("@param:" + id);
    if (!Object.prototype.hasOwnProperty.call(j, key)) return;
    const n = Number(vals[id]);
    if (Number.isFinite(n)) j[key] = n;
  });
  return JSON.stringify(j);
}

function jobInstruction() {
  if (!lastJob.loaded) return {};
  return {
    recipeId: lastJob.recipeId,
    title: lastJob.title,
    executionText: lastJob.executionText,
    compiler: "cos-shape",
    note: "local COS-shaped; 不是云端 COS",
  };
}

function jobPayload() {
  const loaded = !!lastJob.loaded;
  const instruction = jobInstruction();
  const params = loaded ? lastJob.params : [];
  const context = lastJob.context;
  return {
    ok: true,
    instruction: instruction,
    params: params,
    context: context,
    job: {
      instruction: instruction,
      params: params,
      context: context,
      loaded: loaded,
    },
  };
}

function hasParamsFlag(title, content) {
  if (String(title || "").indexOf("可调参数") !== -1) return true;
  const c = String(content || "");
  if (c.indexOf("@param") !== -1) return true;
  try {
    const j = JSON.parse(c);
    if (j && (j.parameters || j.params)) return true;
  } catch (_) {}
  return false;
}

function loadFactoryPresets() {
  if (factoryCache) return factoryCache;
  const items = [];
  let names = [];
  try {
    names = fs.readdirSync(FACTORY_DIR, { encoding: "buffer" }).map(function (b) {
      return Buffer.isBuffer(b) ? b.toString("utf8") : String(b);
    });
  } catch (e) {
    return [];
  }
  for (let i = 0; i < names.length; i++) {
    const fn = names[i];
    if (!fn.endsWith(".json")) continue;
    let j;
    try {
      const raw = fs.readFileSync(path.join(FACTORY_DIR, fn));
      j = JSON.parse(raw.toString("utf8"));
    } catch (_) {
      continue;
    }
    if (!j || j._isFactory !== true || !j.id) continue;
    const category = String(j.category || "");
    items.push({
      id: String(j.id),
      title: String(j.title || ""),
      category: category,
      subCategory: j.subCategory == null ? "" : String(j.subCategory),
      content: String(j.content || ""),
      refImages: Array.isArray(j.refImages) ? j.refImages : [],
      region: CATEGORY_TO_REGION[category] || category || "",
    });
  }
  items.sort(function (a, b) {
    return String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
  });
  factoryCache = items;
  return items;
}

function findRecipe(id) {
  const all = loadFactoryPresets();
  const sid = String(id || "");
  for (let i = 0; i < all.length; i++) {
    if (all[i].id === sid) return all[i];
  }
  return null;
}

function listRecipes(q, region, limit) {
  const all = loadFactoryPresets();
  const query = String(q || "").trim().toLowerCase();
  const regionKey = String(region || "").trim().toLowerCase();
  const cat = regionKey ? (REGION_TO_CATEGORY[regionKey] || regionKey) : "";
  const out = [];
  for (let i = 0; i < all.length; i++) {
    const r = all[i];
    if (cat && r.category !== cat) continue;
    if (query) {
      const hay = (r.title + " " + r.id + " " + r.content).toLowerCase();
      if (hay.indexOf(query) === -1) continue;
    }
    out.push({
      id: r.id,
      title: r.title,
      region: r.region,
      category: r.category,
      subCategory: r.subCategory,
      hasParams: hasParamsFlag(r.title, r.content),
    });
    if (out.length >= limit) break;
  }
  if (out.length === 0 && !query) {
    const fill = all.slice(0, limit).map(function (r) {
      return {
        id: r.id,
        title: r.title,
        region: r.region,
        category: r.category,
        subCategory: r.subCategory,
        hasParams: hasParamsFlag(r.title, r.content),
      };
    });
    return fill;
  }
  return out;
}

/** Local COS-shaped EditPlan. Does not call cloud COS / banana / AJI. */
function resolvePlanContext(body) {
  body = body || {};
  const execution = body.execution && typeof body.execution === "object" ? body.execution : null;
  const bodyHasRecipe = body.recipeId != null && body.recipeId !== "";
  let recipeId = bodyHasRecipe ? String(body.recipeId) : null;
  const recipeMatchesJob = !!(lastJob.loaded && recipeId && String(recipeId) === String(lastJob.recipeId));
  const useJob = body.useJob === true || recipeMatchesJob;
  let title = "";
  let executionText = "";
  let params = Array.isArray(body.params) ? body.params : null;
  if (execution) {
    if (execution.text) executionText = String(execution.text);
    if (execution.title) title = String(execution.title);
  }
  if (useJob && lastJob.loaded) {
    if (!recipeId) recipeId = lastJob.recipeId;
    if (!title) title = lastJob.title;
    if (!executionText) executionText = lastJob.executionText;
    if (!params) params = lastJob.params;
  }
  const rec = recipeId ? findRecipe(recipeId) : null;
  if (rec) {
    if (!title) title = rec.title;
    if (!executionText) executionText = rec.content;
    if (!params) params = parseParamsFromContent(executionText || rec.content);
  }
  if (!params) params = [];
  const loaded = !!(recipeId && (executionText || rec || (useJob && lastJob.loaded && String(lastJob.recipeId) === String(recipeId))));
  const selScope = body.selScope || body.sel || (body.context && body.context.selScope) || null;
  const selection = body.selection || (body.document && body.document.selection) || (body.context && body.context.selection) || null;
  return {
    recipeId: loaded ? recipeId : null,
    title: title || "",
    executionText: executionText || "",
    params: params,
    loaded: loaded,
    userText: body.text != null ? String(body.text) : (useJob ? (lastJob.userText || "") : ""),
    selScope: selScope,
    selection: selection,
  };
}

function attachRecipeMeta(plan, ctx) {
  if (!plan || !ctx || !ctx.loaded) return plan;
  plan.recipeId = ctx.recipeId;
  plan.recipeTitle = ctx.title;
  plan.executionKind = "wheelchair-factory-content";
  plan.execution = {
    kind: "wheelchair-factory-content",
    text: ctx.executionText,
    userText: ctx.userText,
  };
  plan.params = ctx.params;
  return plan;
}

function refusePlan(t, intent, reason, extra) {
  extra = extra || {};
  const plan = {
    schema: "pxdls.EditPlan/v0",
    refuse: true,
    reason: reason,
    intent: intent || null,
    text: t,
    generateDefault: false,
    compiler: "cos-shape",
    note: "local COS-shaped EditPlan; no cloud COS; no banana",
    steps: [],
  };
  Object.keys(extra).forEach(function (k) { plan[k] = extra[k]; });
  return plan;
}

function buildPlan(text, intent, ctx) {
  ctx = ctx || {};
  const t = String(text || "").trim();
  const steps = [];

  if (/出一张|出图|生成|文生图|图生图|txt2img|img2img/.test(t) || intent === "generate") {
    return attachRecipeMeta(
      refusePlan(t, intent || "generate", "拒绝：出图/生成不是本管线。"),
      ctx
    );
  }

  const wantAccept = /接受|accept/.test(t) || intent === "accept-preview";
  const wantLock = /锁|lock|肤质|皮肤质感/.test(t) || intent === "lock-skin";
  const wantRollback = /回滚|撤销这层|rollback|撤这层/.test(t) || intent === "rollback";
  const wantFace = /脸|face|框/.test(t) || intent === "face-then-brighten";
  const wantBrightWord = /亮|bright|提亮/.test(t);
  const wantBrightFromIntent = intent === "face-then-brighten" || intent === "brighten";
  const wantBrightNoRecipe = !ctx.loaded && (wantBrightWord || wantBrightFromIntent);
  /* mask is a first-class PS atom. Keyword only — never auto-add on 框脸再提亮. */
  const wantMask = /蒙版|遮罩/.test(t) || intent === "mask";
  /* fx is a first-class PS atom. Keyword only — never auto-add on 框脸再提亮. */
  const wantFx = /特效|加特效|光晕/.test(t) || intent === "fx";
  /* grade: hue-sat/vibrance PS atom. Keyword only — never stack on 框脸再提亮 or leftover recipe. */
  const wantGrade = /调色|对比度|色相|饱和/.test(t) || intent === "grade";
  /* readback: canvas/layer snapshot atom. Keyword only. */
  const wantReadback = /读回|读画布|读图层/.test(t) || intent === "readback";
  /* select: restore lastCapture.selection. Keyword only — never 框脸/框选脸, never stack on 框脸再提亮. */
  const wantSelect = ((/建选区|用选区/.test(t) || /选区/.test(t)) && !/框脸|框选脸/.test(t)) || intent === "select";
  /* adjust-layer: Curves/Levels adj layer. Keyword only — NOT 提亮, NOT 框脸, never merge into 框脸再提亮. */
  const wantAdjustLayer = ((/调整层|加调整层|曲线层|色阶层/.test(t) || intent === "adjust-layer") && !wantBrightWord && !wantFace);
  const wantRecipeWords = /改|配方/.test(t);
  const pureAccept = wantAccept && !wantLock && !wantFace && !wantBrightWord && !wantMask && !wantFx && !wantGrade && !wantReadback && !wantSelect && !wantAdjustLayer && !/改|修|执行|跑|应用/.test(t);

  if (wantLock) {
    steps.push({ kind: "lock", target: "skin-texture", reason: "preserve pores / makeup" });
  }
  if (wantFace) {
    steps.push({
      kind: "edit",
      atom: "face-box",
      reason: "frame face before grade",
      mock: true,
      real: false,
      label: "模拟不是检测",
    });
  }
  if (ctx.loaded && !pureAccept && !wantGrade && !wantReadback && !(wantSelect && !wantRecipeWords) && !(wantAdjustLayer && !wantRecipeWords)) {
    steps.push({
      kind: "edit",
      skill: ctx.title || "",
      instruction: ctx.executionText || "",
      params: ctx.params || [],
      recipeId: ctx.recipeId || null,
    });
  } else if (wantBrightNoRecipe && !wantAccept && !(wantLock && !wantBrightWord && !wantBrightFromIntent)) {
    steps.push({
      kind: "edit",
      atom: "brighten",
      tool: "curves-or-levels",
      reason: "lift midtones; mask if selection",
    });
  }
  /* Do not auto-add mask on 框脸再提亮. selScope=scope is plugin-side apply, not a plan trigger. */
  if (wantMask) {
    steps.push({
      kind: "edit",
      atom: "mask",
      from: "selection",
      reason: "user mask from current selection",
    });
  }
  /* Do not auto-add fx on 框脸再提亮. */
  if (wantFx) {
    steps.push({
      kind: "edit",
      atom: "fx",
      fx: "outerGlow",
      reason: "layerEffects outerGlow on last layer or current",
    });
  }
  /* Do not auto-add grade on 框脸再提亮 or leftover recipe. */
  if (wantGrade && !ctx.loaded && !wantFace) {
    steps.push({
      kind: "edit",
      atom: "grade",
      tool: "hue-sat",
      reason: "hue/sat or vibrance on lastCapture.selection; no full-doc fallback",
    });
  }
  if (wantReadback) {
    steps.push({
      kind: "edit",
      atom: "readback",
      reason: "document/layer/selection snapshot; no pixels",
    });
  }
  /* Do not auto-add adjust-layer on 框脸再提亮. leftover recipe is not a recipe edit unless 改/配方. */
  if (wantAdjustLayer && !wantFace && !wantBrightWord) {
    steps.push({
      kind: "edit",
      atom: "adjust-layer",
      tool: "curves-or-levels",
      reason: "curves/levels adjustment layer clipped/masked to lastCapture.selection; no full-doc fallback",
    });
  }
  /* Do not auto-add select on 框脸再提亮. leftover recipe is not a select edit unless 改/配方. */
  if (wantSelect && !wantFace) {
    steps.push({
      kind: "edit",
      atom: "select",
      reason: "restore lastCapture.selection; never invent face; never full-doc",
    });
  }
  if (wantAccept) {
    steps.push({ kind: "accept", note: "commit preview; keep last layer" });
  }
  if (wantRollback) {
    steps.push({ kind: "rollback", note: "deleteLayerById last result layer" });
  }

  if (!steps.length) {
    return refusePlan(t, intent, "未知意图，说一下要改什么。不会默认提亮。不会默认第一条配方。", { ask: true });
  }

  return attachRecipeMeta({
    schema: "pxdls.EditPlan/v0",
    refuse: false,
    intent: intent || null,
    intentLabel: "COS 形（本地，无云）",
    text: t,
    generateDefault: false,
    compiler: "cos-shape",
    note: "local COS-shaped EditPlan; no cloud COS; no banana; out图 mock",
    steps: steps,
  }, ctx);
}

function mockFaceBounds(document) {
  const w = Number(document && document.width) || 1024;
  const h = Number(document && document.height) || 1024;
  const boxW = Math.round(w * 0.28);
  const boxH = Math.round(h * 0.36);
  const left = Math.round((w - boxW) / 2);
  const top = Math.round(h * 0.18);
  return {
    left: left,
    top: top,
    right: left + boxW,
    bottom: top + boxH,
    source: "mock",
    unit: "px",
  };
}

const MOCK_VENDOR_LABEL = "模拟供应商 不是香蕉";
const MOCK_VENDOR_PNG = path.join(__dirname, "mock-vendor.png");

/** 1x1 PNG only if the shipped fixture is missing. */
function minimalPngBytes() {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
  );
}

function fixturePngBytes() {
  try {
    if (fs.existsSync(MOCK_VENDOR_PNG)) {
      const buf = fs.readFileSync(MOCK_VENDOR_PNG);
      if (buf && buf.length > 16) return buf;
    }
  } catch (_) {}
  return minimalPngBytes();
}

function getMockImageBase64() {
  return fixturePngBytes().toString("base64");
}

function bananaCreds() { return { key: "", url: "", provider: "mock" }; }
function bananaKey() { return ""; }
function activeVendor() { return "mock"; }

function countRefs(refs) {
  if (!Array.isArray(refs)) return 0;
  let n = 0;
  for (let i = 0; i < refs.length; i++) {
    const r = refs[i];
    const has = typeof r === "string" ? r.length > 0 : !!(r && (r.base64 || r.data || (r.inlineData && r.inlineData.data)));
    if (has) n++;
    if (n >= 4) break;
  }
  return n;
}

function stripDataUrl(s) {
  return String(s || "").replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, "");
}

function imageBytesFrom(val) {
  if (val == null) return "";
  if (typeof val === "string") return stripDataUrl(val);
  if (typeof val === "object") {
    if (val.base64) return stripDataUrl(val.base64);
    if (val.data && typeof val.data === "string") return stripDataUrl(val.data);
    if (val.inlineData && val.inlineData.data) return stripDataUrl(val.inlineData.data);
    if (val.captureBase64) return stripDataUrl(val.captureBase64);
    if (val.mainBase64) return stripDataUrl(val.mainBase64);
  }
  return "";
}

function collectRefList(body) {
  const lists = [body.refs, body.refImages, body.extraImages];
  const out = [];
  for (let i = 0; i < lists.length; i++) {
    const arr = lists[i];
    if (!Array.isArray(arr)) continue;
    for (let j = 0; j < arr.length; j++) {
      const b = imageBytesFrom(arr[j]);
      if (b) out.push(b);
      if (out.length >= 4) return out;
    }
  }
  return out;
}

function promptFromContents(contents) {
  if (!Array.isArray(contents)) return "";
  const texts = [];
  for (let i = 0; i < contents.length; i++) {
    const parts = contents[i] && contents[i].parts;
    if (!Array.isArray(parts)) continue;
    for (let j = 0; j < parts.length; j++) {
      if (parts[j] && parts[j].text != null) texts.push(String(parts[j].text));
    }
  }
  return texts.join("\n");
}

function imagesFromContents(contents) {
  if (!Array.isArray(contents)) return [];
  const imgs = [];
  for (let i = 0; i < contents.length; i++) {
    const parts = contents[i] && contents[i].parts;
    if (!Array.isArray(parts)) continue;
    for (let j = 0; j < parts.length; j++) {
      const p = parts[j];
      if (p && p.inlineData && p.inlineData.data) imgs.push(stripDataUrl(p.inlineData.data));
    }
  }
  return imgs;
}

function gcdInt(a, b) {
  a = Math.abs(Math.round(a));
  b = Math.abs(Math.round(b));
  while (b) { const t = a % b; a = b; b = t; }
  return a || 1;
}

function dimsFromSelectionOrBody(body) {
  body = body || {};
  const sel = body.selection || (body.reuseCapture && body.reuseCapture.selection) || null;
  let w = 0, h = 0;
  if (sel) {
    w = Number(sel.width);
    h = Number(sel.height);
    if (!(w > 0 && h > 0) && sel.right != null && sel.left != null && sel.bottom != null && sel.top != null) {
      w = Number(sel.right) - Number(sel.left);
      h = Number(sel.bottom) - Number(sel.top);
    }
  }
  if (!(w > 0 && h > 0) && body.width && body.height) {
    w = Number(body.width);
    h = Number(body.height);
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

function normalizeApplyInbound(body, routeModel) {
  body = body || {};
  const gc = body.generationConfig || {};
  const imgCfg = gc.imageConfig || {};
  const fromContents = Array.isArray(body.contents);
  let prompt = body.prompt != null ? String(body.prompt) : "";
  if (!prompt && fromContents) prompt = promptFromContents(body.contents);

  let main = imageBytesFrom(body.image || body.base64 || body.captureBase64 || body.mainBase64);
  if (!main && body.capture) main = imageBytesFrom(body.capture);
  if (!main && body.reuseCapture) main = imageBytesFrom(body.reuseCapture);
  const contentImgs = fromContents ? imagesFromContents(body.contents) : [];
  if (!main && contentImgs.length) main = contentImgs[0];

  let refs = collectRefList(body);
  if (!refs.length && contentImgs.length > 1) refs = contentImgs.slice(1, 5);

  const dims = dimsFromSelectionOrBody(body);
  let size = body.size || imgCfg.imageSize || null;
  let aspectRatio = body.aspectRatio || imgCfg.aspectRatio || null;
  if (!aspectRatio) aspectRatio = dims ? tokenAspectFromDims(dims.w, dims.h) : null;
  if (!size) size = dims ? sizeTokenFromLongEdge(dims.w, dims.h) : null;
  const model = body.model || routeModel || "AJbanana3";
  let provider = body.provider || "mock";
  if (provider !== "aji" && provider !== "grs" && provider !== "mock") provider = "mock";

  return {
    prompt: prompt,
    main: main,
    mainBytes: main ? String(main).length : 0,
    refsCount: Math.min(refs.length, 4),
    size: size,
    aspectRatio: aspectRatio,
    model: model,
    provider: provider,
    selection: body.selection || null,
    document: body.document || null,
    docId: body.docId != null ? body.docId : (body.document && body.document.id),
    layerType: body.layerType || "smartObject",
    recipeId: body.recipeId || null,
    reuseCapture: !!(body.reuseCapture && (body.reuseCapture.base64 || typeof body.reuseCapture === "string")),
    ignore: body.ignore || null,
    negPrompt: body.negPrompt != null ? String(body.negPrompt) : "",
    refs: refs,
    inbound: body,
  };
}

async function respondApply(res, body, routeModel) {
  const n = normalizeApplyInbound(body, routeModel);
  lastApplyMeta = {
    ts: Date.now(),
    prompt: n.prompt,
    mainBytes: n.mainBytes,
    hasImage: n.mainBytes > 0,
    imageBytes: n.mainBytes,
    promptChars: n.prompt.length,
    refsCount: n.refsCount,
    size: n.size,
    aspectRatio: n.aspectRatio,
    model: n.model,
    provider: "mock",
    selection: n.selection,
    document: n.document,
    docId: n.docId,
    layerType: n.layerType,
    recipeId: n.recipeId,
    reuseCapture: n.reuseCapture,
    ignore: n.ignore,
    negPrompt: n.negPrompt,
    vendor: "mock",
    mock: true,
    generated: true,
    reason: MOCK_VENDOR_LABEL,
    label: MOCK_VENDOR_LABEL,
  };
  return send(res, 200, {
    ok: true,
    generated: true,
    reason: MOCK_VENDOR_LABEL,
    label: MOCK_VENDOR_LABEL,
    vendor: "mock",
    mock: true,
    lastCapture: lastApplyMeta,
    lastApplyMeta: lastApplyMeta,
    base64: getMockImageBase64(),
  });
}

const server = http.createServer(async (req, res) => {
  try {
  const url = new URL(req.url, "http://" + HOST + ":" + PORT);
  if (await agentHttp.handle(req, res, url)) return;
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    });
    return res.end();
  }

  const pathName = url.pathname.replace(/\/+$/, "") || "/";

    if (req.method === "GET" && pathName === "/health") {
      return send(res, 200, {
        ok: true,
        status: "ok",
        product: "PXD/LS studio alpha",
        service: "com.pxdls.companion",
        pid: process.pid,
        startedAt: STARTED_AT,
        port: PORT,
        forge: false,
        comfy: false,
        generateDefault: false,
        banana: false,
        vendor: "mock",
        label: MOCK_VENDOR_LABEL,
        recipes: loadFactoryPresets().length,
        agent: { engine: "codex-app-server", status: agentHttp.agent.connection.status },
      });
    }

    if (req.method === "GET" && pathName === "/recipes") {
      let limit = Number(url.searchParams.get("limit") || 8);
      if (!Number.isFinite(limit) || limit < 1) limit = 8;
      if (limit > 8) limit = 8;
      const q = url.searchParams.get("q") || "";
      const region = url.searchParams.get("region") || url.searchParams.get("part") || "";
      const items = listRecipes(q, region, limit);
      return send(res, 200, {
        ok: true,
        source: "wheelchair/factory_presets",
        q: q,
        region: region,
        items: items,
      });
    }

    const recipeGet = pathName.match(/^\/recipes\/([^/]+)$/);
    if (req.method === "GET" && recipeGet) {
      const rec = findRecipe(decodeURIComponent(recipeGet[1]));
      if (!rec) return send(res, 404, { ok: false, error: "not found" });
      return send(res, 200, {
        ok: true,
        recipe: {
          id: rec.id,
          title: rec.title,
          region: rec.region,
          category: rec.category,
          subCategory: rec.subCategory,
          content: rec.content,
          refImages: rec.refImages,
          params: parseParamsFromContent(rec.content),
          hasParams: hasParamsFlag(rec.title, rec.content),
        },
      });
    }

    const recipeLoad = pathName.match(/^\/recipes\/([^/]+)\/load$/);
    if (req.method === "POST" && recipeLoad) {
      const rec = findRecipe(decodeURIComponent(recipeLoad[1]));
      if (!rec) return send(res, 404, { ok: false, error: "not found" });
      const body = await readBody(req);
      const userText = body.text != null ? String(body.text) : "";
      const params = parseParamsFromContent(rec.content);
      lastLoaded = { id: rec.id, title: rec.title, region: rec.region };
      lastJob = {
        recipeId: rec.id,
        title: rec.title,
        executionText: rec.content,
        userText: userText,
        params: params,
        context: lastJob.context,
        loaded: true,
      };
      return send(res, 200, {
        ok: true,
        loaded: lastLoaded,
        params: params,
        execution: {
          kind: "wheelchair-factory-content",
          text: rec.content,
          userText: userText,
        },
        next: "POST /plan",
      });
    }

    if (req.method === "GET" && pathName === "/job") {
      return send(res, 200, jobPayload());
    }

    if (req.method === "POST" && pathName === "/job") {
      let body = {};
      try { body = await readBody(req); } catch (_) { body = {}; }
      if (!body || typeof body !== "object") body = {};
      const inst = (body.instruction && typeof body.instruction === "object") ? body.instruction : {};
      if (inst.recipeId != null && inst.recipeId !== "") {
        lastJob.recipeId = String(inst.recipeId);
        const rec = findRecipe(lastJob.recipeId);
        if (rec) {
          if (inst.title == null) lastJob.title = rec.title;
          if (inst.executionText == null) lastJob.executionText = rec.content;
          if (!Array.isArray(body.params)) lastJob.params = parseParamsFromContent(rec.content);
        }
      }
      if (inst.title != null) lastJob.title = String(inst.title);
      if (inst.executionText != null) lastJob.executionText = String(inst.executionText);
      if (inst.userText != null) lastJob.userText = String(inst.userText);
      if (Array.isArray(body.params)) lastJob.params = body.params;
      if (body.context && typeof body.context === "object") {
        lastJob.context = {
          document: body.context.document !== undefined ? body.context.document : lastJob.context.document,
          selection: body.context.selection !== undefined ? body.context.selection : lastJob.context.selection,
          refs: Array.isArray(body.context.refs) ? body.context.refs.slice(0, 4) : lastJob.context.refs,
        };
      }
      if (body.document !== undefined) lastJob.context.document = body.document;
      if (body.selection !== undefined) lastJob.context.selection = body.selection;
      if (Array.isArray(body.refs)) lastJob.context.refs = body.refs.slice(0, 4);
      if (body.loaded === false) lastJob.loaded = false;
      else if (body.loaded === true || lastJob.recipeId || lastJob.executionText) {
        lastJob.loaded = !!(lastJob.recipeId || lastJob.executionText);
      }
      if (lastJob.loaded && lastJob.recipeId) {
        lastLoaded = { id: lastJob.recipeId, title: lastJob.title, region: null };
      }
      return send(res, 200, jobPayload());
    }

    if (req.method === "POST" && pathName === "/job/params") {
      const body = await readBody(req);
      if (!lastJob.loaded) {
        return send(res, 400, { ok: false, error: "no recipe loaded" });
      }
      if (body.recipeId && String(body.recipeId) !== String(lastJob.recipeId)) {
        return send(res, 400, { ok: false, error: "recipeId mismatch" });
      }
      lastJob.executionText = applyParamValues(lastJob.executionText, body.values || {});
      lastJob.params = parseParamsFromContent(lastJob.executionText);
      const planText = lastJob.userText || lastJob.title || "";
      const ctx = resolvePlanContext({
        text: planText,
        intent: body.intent,
        recipeId: lastJob.recipeId,
        params: lastJob.params,
        execution: { kind: "wheelchair-factory-content", text: lastJob.executionText, userText: lastJob.userText, title: lastJob.title },
      });
      const plan = buildPlan(planText, body.intent, ctx);
      const out = jobPayload();
      out.plan = plan;
      out.next = "POST /plan";
      return send(res, 200, out);
    }

    if (req.method === "POST" && pathName === "/job/context") {
      const body = await readBody(req);
      lastJob.context = {
        document: body.document || lastJob.context.document,
        selection: body.selection || lastJob.context.selection,
        refs: Array.isArray(body.refs) ? body.refs.slice(0, 4) : lastJob.context.refs,
      };
      return send(res, 200, jobPayload());
    }

    if (req.method === "POST" && pathName === "/plan") {
      const body = await readBody(req);
      const ctx = resolvePlanContext(body);
      const plan = buildPlan(body.text, body.intent, ctx);
      const refuse = !!plan.refuse;
      return send(res, 200, {
        ok: !refuse,
        refuse: refuse,
        plan: plan,
        document: body.document || null,
      });
    }

    if (req.method === "POST" && pathName === "/compile") {
      const body = await readBody(req);
      const userText = body.text != null ? String(body.text) : "";
      const ctx = resolvePlanContext(body);
      const plan = buildPlan(userText, body.intent, ctx);
      const promptParts = [];
      if (userText) promptParts.push(userText);
      if (ctx.loaded && ctx.executionText) promptParts.push(ctx.executionText);
      const rec = ctx.recipeId ? findRecipe(ctx.recipeId) : null;
      const refuse = !!plan.refuse;
      return send(res, 200, {
        ok: !refuse,
        refuse: refuse,
        plan: plan,
        prompt: promptParts.join("\n\n"),
        recipe: rec
          ? { id: rec.id, title: rec.title, region: rec.region }
          : (ctx.loaded ? { id: ctx.recipeId, title: ctx.title } : null),
        compiler: "cos-shape",
      });
    }

    if (req.method === "GET" && (pathName === "/lastApplyMeta" || pathName === "/apply/last")) {
      return send(res, 200, { ok: true, lastApplyMeta: lastApplyMeta });
    }

    if (req.method === "POST" && pathName === "/apply") {
      const body = await readBody(req);
      return respondApply(res, body, null);
    }

    if (req.method === "POST" && pathName === "/atom/face-box") {
      const body = await readBody(req);
      const bounds = mockFaceBounds(body.document || {});
      return send(res, 200, { ok: true, bounds: bounds, real: false, source: "mock" });
    }

    if (req.method === "POST" && pathName === "/atom/mask") {
      const body = await readBody(req);
      const hasSel = body.hasSelection === true || !!(body.selection && (body.selection.left != null || body.selection.width > 0));
      return send(res, 200, {
        ok: true,
        instruction: hasSel
          ? "user mask from current selection (revealSelection) on last returned layer or new adj layer"
          : "need selection; fail {applied:false,reason}",
        hasSelection: hasSel,
        from: "selection",
        atom: "mask",
        note: "plugin applies via executeAsModal + batchPlay; not silent",
      });
    }

    if (req.method === "POST" && pathName === "/atom/fx") {
      const body = await readBody(req);
      return send(res, 200, {
        ok: true,
        instruction: "set layerEffects outerGlow on last layer or current",
        atom: "fx",
        fx: body.fx || "outerGlow",
        note: "plugin applies via executeAsModal + batchPlay; fail {applied:false,reason}; not silent",
      });
    }

    if (req.method === "POST" && pathName === "/atom/grade") {
      const body = await readBody(req);
      const hasSel = body.hasSelection === true || !!(body.selection && (body.selection.left != null || body.selection.width > 0));
      return send(res, 200, {
        ok: true,
        instruction: hasSel
          ? "hueSaturation/vibrance on lastCapture.selection"
          : "need selection; fail {applied:false,reason:NO_SELECTION}",
        hasSelection: hasSel,
        atom: "grade",
        tool: body.tool || "hue-sat",
        note: "plugin applyGradeInPs via executeAsModal + batchPlay; no full-doc fallback; not banana; not hue-flip",
      });
    }

    if (req.method === "POST" && pathName === "/atom/adjust-layer") {
      const body = await readBody(req);
      const hasSel = body.hasSelection === true || !!(body.selection && (body.selection.left != null || body.selection.width > 0));
      return send(res, 200, {
        ok: true,
        instruction: hasSel
          ? "create Curves (or Levels) adjustment layer clipped/masked to lastCapture.selection"
          : "need lastCapture.selection; fail {applied:false,reason:NO_SELECTION}",
        hasSelection: hasSel,
        atom: "adjust-layer",
        tool: body.tool || "curves-or-levels",
        note: "plugin applyAdjustLayerInPs via executeAsModal + batchPlay; no full-doc fallback",
      });
    }

    if (req.method === "POST" && pathName === "/atom/select") {
      const body = await readBody(req);
      const hasSel = body.hasSelection === true || !!(body.selection && (body.selection.left != null || body.selection.width > 0));
      return send(res, 200, {
        ok: true,
        instruction: hasSel
          ? "restore lastCapture.selection via setSelection"
          : "need lastCapture.selection; fail {applied:false,reason:NO_SELECTION}",
        hasSelection: hasSel,
        atom: "select",
        note: "plugin applySelectInPs via executeAsModal + batchPlay; no invent face; no full-doc; companion does not write PS",
      });
    }

    if (req.method === "POST" && pathName === "/atom/readback") {
      const body = await readBody(req);
      const doc = body.document || body.doc || null;
      const layer = body.layer || (doc && (doc.layer || doc.activeLayer)) || null;
      const sel = body.selection || (doc && doc.selection) || null;
      const hasHost = !!(doc && (doc.id != null || doc.open === true || doc.name || doc.width));
      if (!hasHost && !body.host) {
        return send(res, 200, {
          ok: false,
          applied: false,
          atom: "readback",
          reason: "HOST_MISSING",
          note: "companion has no PS host; plugin must send document snapshot",
        });
      }
      const hasSelection = !!(sel && (sel.left != null || sel.width > 0 || sel.hasSelection === true));
      const snapshot = {
        document: doc ? {
          id: doc.id != null ? doc.id : (body.docId != null ? body.docId : null),
          name: doc.name || doc.title || null,
          width: doc.width != null ? doc.width : null,
          height: doc.height != null ? doc.height : null,
          bounds: doc.bounds || null,
        } : null,
        layer: layer && typeof layer === "object" ? {
          id: layer.id != null ? layer.id : (doc && doc.layerId != null ? doc.layerId : null),
          name: layer.name || (typeof doc.layer === "string" ? doc.layer : null),
          bounds: layer.bounds || null,
        } : (doc && doc.layerId != null ? { id: doc.layerId, name: doc.layer || null, bounds: null } : null),
        selection: sel || null,
        hasSelection: hasSelection,
      };
      return send(res, 200, {
        ok: true,
        atom: "readback",
        snapshot: snapshot,
        document: snapshot.document,
        layer: snapshot.layer,
        selection: snapshot.selection,
        hasSelection: hasSelection,
        note: "ids/bounds/hasSelection only; no pixels",
      });
    }

    if (req.method === "POST" && pathName === "/atom/brighten") {
      const body = await readBody(req);
      const hasSel = body.hasSelection === true || !!(body.selection && body.selection.left != null);
      const pass = imageBytesFrom(body.image || body.base64 || body.captureBase64 || body.mainBase64 || body.capture);
      const out = {
        ok: true,
        instruction: hasSel
          ? "create Curves adjustment layer; mask from current selection"
          : "create new layer + Levels/Curves adjustment (no selection)",
        hasSelection: hasSel,
        tool: hasSel ? "curves" : "levels",
        note: "plugin applies via executeAsModal + batchPlay",
      };
      if (pass) out.base64 = pass;
      return send(res, 200, out);
    }

    return send(res, 404, { ok: false, error: "not found", path: pathName });
  } catch (e) {
    return send(res, 400, { ok: false, error: String(e && e.message ? e.message : e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(JSON.stringify({ time: STARTED_AT, event: "companion.started", pid: process.pid, host: HOST, port: server.address().port }));
});

let lastAgentStatus = "";
agentHttp.agent.on("change", () => {
  const connection = agentHttp.agent.connection.status;
  const session = agentHttp.agent.session.status;
  const status = connection + ":" + session;
  if (status === lastAgentStatus) return;
  lastAgentStatus = status;
  // Lifecycle only: never log prompts, image data, credentials or tool output.
  console.log(JSON.stringify({ time: new Date().toISOString(), event: "agent.state", connection, session }));
});

for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
  console.log(JSON.stringify({ time: new Date().toISOString(), event: "companion.stopping", signal }));
  agentHttp.agent.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
});
