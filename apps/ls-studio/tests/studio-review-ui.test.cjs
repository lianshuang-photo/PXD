const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { mount } = require('../plugin/studio-review-014');

class Element extends EventTarget {
  constructor(tag, document) {
    super(); this.tagName = tag; this.ownerDocument = document; this.children = []; this.attributes = new Map(); this.className = ''; this.value = ''; this.hidden = false; this.disabled = false; this.textContent = ''; this.parentElement = null;
    this.classList = { add: name => { const values = new Set(this.className.split(' ')); values.add(name); this.className = [...values].join(' '); }, remove: name => { this.className = this.className.split(' ').filter(value => value !== name).join(' '); }, contains: name => this.className.split(' ').includes(name), toggle: (name, enabled) => { if (enabled) this.classList.add(name); else this.classList.remove(name); } };
  }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  hasAttribute(key) { return this.attributes.has(key); }
  removeAttribute(key) { this.attributes.delete(key); }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
  removeChild(child) { this.children = this.children.filter(value => value !== child); child.parentElement = null; return child; }
  get firstChild() { return this.children[0] || null; }
  set innerHTML(_) { throw Error('Review content must not enter innerHTML'); }
  focus() { this.ownerDocument.activeElement = this; this.dispatchEvent(new Event('focus')); }
  click() { this.dispatchEvent(new Event('click')); }
}
const copy = value => structuredClone(value);
const now = '2026-10-04T03:00:00.000Z';
const fresh = () => ({ revision: 0, feedback: [], acceptance: null });
const feedback = description => ({ items: [{ category: 'detail', description }], preserve: [] });
const record = (resultId, value, via = 'agent') => ({ resultId, ...copy(value), recordedVia: via, updatedAt: now });
const review = (number, entries = [], acceptance = null) => ({ revision: number, feedback: copy(entries), acceptance: acceptance === null ? null : { resultId: acceptance, recordedVia: 'agent', updatedAt: now }, updatedAt: now });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const error = (code, details) => Object.assign(Error('sensitive provider secret https://private.invalid/token'), { code, details });
const turn = () => new Promise(resolve => setImmediate(resolve));
async function settle() { await turn(); await turn(); }
function edit(input, value) { input.value = value; input.dispatchEvent(new Event(input.tagName === 'select' ? 'change' : 'input')); }

function fixture() {
  const doc = new EventTarget(); doc.createElement = tag => new Element(tag, doc); doc.body = doc.createElement('body'); doc.querySelectorAll = () => [];
  const win = { document: doc }; vm.runInNewContext(fs.readFileSync(require.resolve('../plugin/ui-014'), 'utf8'), { window: win, document: doc, Event });
  const calls = [], navigations = [], states = new Map();
  for (const jobId of ['job-a', 'job-b', 'job-parent']) states.set(jobId, { job: { jobId, snapshot: { capabilityId: 'image.edit', revision: 77 }, results: [{ resultId: `${jobId}-1`, assetId: 'same-asset' }, { resultId: `${jobId}-2`, assetId: 'same-asset' }] }, review: fresh(), previousAccepted: null, requests: new Map() });
  function dispatch(operation, args) {
    const current = states.get(args.jobId); assert.ok(current, 'known job');
    if (operation === 'getJobReview') return copy({ jobId: args.jobId, review: current.review, previousAccepted: current.previousAccepted });
    assert.ok(['updateResultFeedback', 'setAcceptedResult'].includes(operation), 'review must not call provider, capture or Photoshop');
    const previous = current.requests.get(args.requestId), fingerprint = JSON.stringify({ operation, args });
    if (previous) { assert.equal(fingerprint, previous.fingerprint, 'retry must retain the entire exact request'); return copy({ jobId: args.jobId, review: current.review, appliedRevision: previous.revision, duplicate: true }); }
    if (current.review.revision !== args.expectedReviewRevision) throw error('REVIEW_REVISION_CONFLICT', { jobId: args.jobId, current: copy(current.review) });
    const next = copy(current.review); next.revision++; next.updatedAt = now;
    if (operation === 'updateResultFeedback') { next.feedback = next.feedback.filter(value => value.resultId !== args.resultId); if (args.feedback !== null) next.feedback.push(record(args.resultId, args.feedback, 'ui')); }
    else next.acceptance = { resultId: args.resultId, recordedVia: 'ui', updatedAt: now };
    current.review = next; current.requests.set(args.requestId, { fingerprint, revision: next.revision });
    return copy({ jobId: args.jobId, review: next, appliedRevision: next.revision, duplicate: false });
  }
  let handler = (operation, args) => dispatch(operation, args);
  function transport(base) { return { base, call(operation, args) { calls.push({ base, operation, args: copy(args) }); return handler(operation, args, dispatch); } }; }
  let currentTransport = transport('http://localhost:17889'), navigation = () => true;
  const mounted = mount({ document: doc, ui: win.PXD_UI, parent: doc.body, getTransport: () => currentTransport, onSelectResult: (jobId, resultId) => { navigations.push({ jobId, resultId }); return navigation(jobId, resultId); }, onError: () => { throw Error('No raw errors may escape review'); } });
  let selectedJob = 'job-a', selectedResult = 'job-a-1';
  function render(jobId = selectedJob, resultId = selectedResult, busy = false) { selectedJob = jobId; selectedResult = resultId; mounted.render({ job: copy(states.get(jobId).job), resultId, busy }); }
  const f = { doc, ui: win.PXD_UI, calls, navigations, states, mounted, nodes: mounted.nodes, render, dispatch, async ready(jobId, resultId) { render(jobId, resultId); await mounted.refresh(); }, setHandler(value) { handler = value; }, resetHandler() { handler = (operation, args) => dispatch(operation, args); }, setNavigation(value) { navigation = value; }, reconnect(base = 'http://localhost:17889') { mounted.reset(); currentTransport = transport(base); render(); }, writes() { return calls.filter(value => value.operation !== 'getJobReview'); }, dispose() { mounted.dispose(); } };
  return f;
}

test('complete multi-item Agent feedback and multiline preserve entries survive editing and review CAS', async () => {
  const f = fixture(); try {
    const data = { items: Array.from({ length: 20 }, (_, index) => ({ area: `区域 ${index}`, category: ['identity', 'composition', 'lighting', 'color', 'detail', 'artifact', 'scope', 'style', 'other'][index % 9], description: `问题 ${index}\n第二行 <literal>`, requestedChange: `修改 ${index}` })), preserve: Array.from({ length: 20 }, (_, index) => `保留 ${index}\n原文`) };
    f.states.get('job-a').review = review(8, [record('job-a-1', data)]); await f.ready();
    assert.equal(f.nodes.studioReviewItemFields.length, 20); assert.equal(f.nodes.studioReviewPreserveFields.length, 20); assert.ok(f.ui.isDisabled(f.nodes.studioReviewAddItem));
    const field = f.nodes.studioReviewItemFields[19].description; field.focus(); assert.ok(field.parentElement.classList.contains('is-focused'));
    edit(field, '最后一项的新意见'); field.dispatchEvent(new Event('blur')); assert.ok(!field.parentElement.classList.contains('is-focused'));
    const key = new Event('keydown', { cancelable: true }); Object.assign(key, { key: 'Enter', isComposing: true }); field.dispatchEvent(key); assert.equal(key.defaultPrevented, false); assert.equal(f.writes().length, 0);
    f.nodes.studioReviewSave.click(); await settle();
    const saved = f.writes()[0]; assert.equal(saved.operation, 'updateResultFeedback'); assert.equal(saved.args.expectedReviewRevision, 8); assert.notEqual(saved.args.expectedReviewRevision, 77);
    data.items[19].description = '最后一项的新意见'; assert.deepEqual(saved.args.feedback, data); assert.match(f.nodes.studioReviewMessage.textContent, /反馈已保存/); assert.ok(f.ui.isDisabled(f.nodes.studioReviewSave));
  } finally { f.dispose(); }
});

test('polling preserves dirty text across job/result switches and exposes current shared feedback', async () => {
  const f = fixture(); try {
    f.states.get('job-a').review = review(1, [record('job-a-1', feedback('原意见'))]); await f.ready();
    edit(f.nodes.studioReviewItemFields[0].description, '本地意见');
    f.states.get('job-a').review = review(2, [record('job-a-1', feedback('Agent 新意见'))]); await f.mounted.refresh();
    assert.equal(f.nodes.studioReviewItemFields[0].description.value, '本地意见'); assert.equal(f.nodes.studioReviewConflict.hidden, false); assert.match(f.nodes.studioReviewCurrentFeedback.textContent, /Agent 新意见/); assert.ok(f.ui.isDisabled(f.nodes.studioReviewSave));
    await f.ready('job-a', 'job-a-2'); assert.equal(f.nodes.studioReviewItemFields.length, 0);
    f.nodes.studioReviewAddItem.click(); edit(f.nodes.studioReviewItemFields[0].description, '另一候选意见');
    await f.ready('job-b', 'job-b-1'); await f.ready('job-a', 'job-a-1'); assert.equal(f.nodes.studioReviewItemFields[0].description.value, '本地意见');
    f.nodes.studioReviewReload.click(); await settle(); assert.equal(f.nodes.studioReviewItemFields[0].description.value, 'Agent 新意见'); assert.equal(f.nodes.studioReviewConflict.hidden, true);
    await f.ready('job-a', 'job-a-2'); assert.equal(f.nodes.studioReviewItemFields[0].description.value, '另一候选意见'); assert.equal(f.writes().length, 0);
  } finally { f.dispose(); }
});

test('review conflicts retain current and local feedback without reaching draft operations', async () => {
  const f = fixture(); try {
    await f.ready(); f.nodes.studioReviewAddItem.click(); edit(f.nodes.studioReviewItemFields[0].description, '本地修改');
    f.states.get('job-a').review = review(1, [record('job-a-1', feedback('其他入口已保存'))]);
    f.nodes.studioReviewSave.click(); await settle();
    assert.equal(f.writes().length, 1); assert.equal(f.writes()[0].args.expectedReviewRevision, 0); assert.equal(f.nodes.studioReviewItemFields[0].description.value, '本地修改');
    assert.match(f.nodes.studioReviewError.textContent, /未保存这次修改/); assert.equal(f.nodes.studioReviewConflict.hidden, false); assert.match(f.nodes.studioReviewCurrentFeedback.textContent, /其他入口已保存/); assert.ok(f.ui.isDisabled(f.nodes.studioReviewAccept));
    f.nodes.studioReviewReload.click(); await settle(); assert.equal(f.nodes.studioReviewItemFields[0].description.value, '其他入口已保存'); assert.ok(!f.ui.isDisabled(f.nodes.studioReviewAccept)); assert.ok(!/secret|private/.test(f.nodes.studioReviewError.textContent));
  } finally { f.dispose(); }
});

test('uncertain save retries the frozen original request while preserving subsequent edits', async () => {
  const f = fixture(); try {
    await f.ready(); f.nodes.studioReviewAddItem.click(); edit(f.nodes.studioReviewItemFields[0].description, '第一次意见');
    let once = true;
    f.setHandler((operation, args, dispatch) => { const result = dispatch(operation, args); if (operation === 'updateResultFeedback' && once) { once = false; assert.ok(Object.isFrozen(args)); assert.ok(Object.isFrozen(args.feedback.items[0])); throw error('NETWORK_ERROR'); } return result; });
    f.nodes.studioReviewSave.click(); await settle(); assert.match(f.nodes.studioReviewError.textContent, /尚未确认/); assert.equal(f.nodes.studioReviewRetry.hidden, false); assert.ok(f.ui.isDisabled(f.nodes.studioReviewAccept));
    edit(f.nodes.studioReviewItemFields[0].description, '保存期间继续编辑'); f.nodes.studioReviewSave.click(); assert.equal(f.writes().length, 1);
    await f.ready('job-b', 'job-b-1'); await f.ready('job-a', 'job-a-1'); f.nodes.studioReviewRetry.click(); await settle();
    assert.equal(f.writes().length, 2); assert.deepEqual(f.writes()[0].args, f.writes()[1].args); assert.equal(f.nodes.studioReviewItemFields[0].description.value, '保存期间继续编辑'); assert.ok(!f.ui.isDisabled(f.nodes.studioReviewSave)); assert.equal(f.nodes.studioReviewRetry.hidden, true);
    f.nodes.studioReviewSave.click(); await settle(); assert.equal(f.writes()[2].args.expectedReviewRevision, 1); assert.notEqual(f.writes()[2].args.requestId, f.writes()[1].args.requestId); assert.equal(f.writes()[2].args.feedback.items[0].description, '保存期间继续编辑');
  } finally { f.dispose(); }
});

test('duplicate ACK displays current review after subsequent Agent edits, not stale submitted feedback', async () => {
  const f = fixture(); try {
    await f.ready(); f.nodes.studioReviewAddItem.click(); edit(f.nodes.studioReviewItemFields[0].description, '原提交'); let fail = true;
    f.setHandler((operation, args, dispatch) => { const result = dispatch(operation, args); if (operation !== 'getJobReview' && fail) { fail = false; throw error('STORAGE_UNAVAILABLE'); } return result; });
    f.nodes.studioReviewSave.click(); await settle();
    f.states.get('job-a').review = review(2, [record('job-a-1', feedback('后续 Agent 反馈'))], 'job-a-2');
    f.nodes.studioReviewRetry.click(); await settle();
    assert.deepEqual(f.writes()[0].args, f.writes()[1].args); assert.equal(f.nodes.studioReviewItemFields[0].description.value, '后续 Agent 反馈'); assert.match(f.nodes.studioReviewStatus.textContent, /当前采用候选 2/); assert.match(f.nodes.studioReviewMessage.textContent, /后续更新/); assert.ok(f.ui.isDisabled(f.nodes.studioReviewSave));
  } finally { f.dispose(); }
});

test('authoritative CAS after a never-applied uncertain request resolves to a recoverable local-preserving conflict', async () => {
  const f = fixture(); try {
    await f.ready(); f.nodes.studioReviewAddItem.click(); edit(f.nodes.studioReviewItemFields[0].description, '保留本地意见');
    f.setHandler((operation, args, dispatch) => { if (operation !== 'getJobReview') throw error('NETWORK_ERROR'); return dispatch(operation, args); });
    f.nodes.studioReviewSave.click(); await settle(); assert.equal(f.states.get('job-a').review.revision, 0);
    f.states.get('job-a').review = review(1, [record('job-a-1', feedback('Agent 新意见'))]);
    f.setHandler((operation, args, dispatch) => { if (operation !== 'getJobReview') throw error('REVIEW_REVISION_CONFLICT'); return dispatch(operation, args); });
    f.nodes.studioReviewRetry.click(); await settle(); assert.equal(f.nodes.studioReviewRetry.hidden, false, 'unverifiable CAS details cannot confirm the original outcome');
    f.resetHandler(); f.nodes.studioReviewRetry.click(); await settle();
    assert.deepEqual(f.writes()[0].args, f.writes()[2].args);
    assert.equal(f.nodes.studioReviewRetry.hidden, true); assert.equal(f.nodes.studioReviewConflict.hidden, false);
    assert.match(f.nodes.studioReviewError.textContent, /上次保存未写入/);
    assert.equal(f.nodes.studioReviewItemFields[0].description.value, '保留本地意见');
    assert.ok(!f.ui.isDisabled(f.nodes.studioReviewReload));
    f.nodes.studioReviewReload.click(); await settle(); assert.equal(f.nodes.studioReviewItemFields[0].description.value, 'Agent 新意见');
    edit(f.nodes.studioReviewItemFields[0].description, '协调后的意见'); f.nodes.studioReviewSave.click(); await settle();
    assert.equal(f.writes()[3].args.expectedReviewRevision, 1); assert.notEqual(f.writes()[3].args.requestId, f.writes()[0].args.requestId);
    assert.equal(f.states.get('job-a').review.revision, 2);
  } finally { f.dispose(); }
});

test('save/delete ACK and intervening read preserve a newer edit that reverts to original text', async () => {
  for (const deleting of [false, true]) {
    const f = fixture(); try {
      f.states.get('job-a').review = review(1, [record('job-a-1', feedback('原文'))]); await f.ready();
      if (!deleting) edit(f.nodes.studioReviewItemFields[0].description, '已发送意见');
      const pending = deferred(); f.setHandler((operation, args, dispatch) => { const value = dispatch(operation, args); return operation === 'updateResultFeedback' ? pending.promise.then(() => value) : value; });
      f.nodes[deleting ? 'studioReviewDelete' : 'studioReviewSave'].click(); await turn();
      edit(f.nodes.studioReviewItemFields[0].description, '暂时修改'); edit(f.nodes.studioReviewItemFields[0].description, '原文');
      await f.mounted.refresh(); assert.equal(f.nodes.studioReviewItemFields[0].description.value, '原文');
      pending.resolve(); await settle(); assert.equal(f.nodes.studioReviewItemFields[0].description.value, '原文'); assert.match(f.nodes.studioReviewStatus.textContent, /未保存修改/); assert.ok(!f.ui.isDisabled(f.nodes.studioReviewSave));
      f.resetHandler(); f.nodes.studioReviewSave.click(); await settle(); assert.equal(f.writes()[1].args.expectedReviewRevision, 2); assert.equal(f.writes()[1].args.feedback.items[0].description, '原文');
    } finally { f.dispose(); }
  }
});

test('malformed or mismatched write ACK remains uncertain and cannot unlock a competing mutation', async () => {
  for (const change of [ack => null, ack => ({ ...ack, jobId: 'wrong-job' }), ack => ({ ...ack, appliedRevision: 99 }), ack => ({ ...ack, duplicate: undefined }), ack => ({ ...ack, review: review(1, [record('job-a-1', feedback('wrong'), 'ui')]) })]) {
    const f = fixture(); try {
      await f.ready(); f.nodes.studioReviewAddItem.click(); edit(f.nodes.studioReviewItemFields[0].description, '必须确认的意见');
      f.setHandler((operation, args, dispatch) => { const ack = dispatch(operation, args); return operation === 'getJobReview' ? ack : change(ack); });
      f.nodes.studioReviewSave.click(); await settle(); assert.equal(f.nodes.studioReviewRetry.hidden, false); assert.match(f.nodes.studioReviewError.textContent, /尚未确认/); assert.ok(f.ui.isDisabled(f.nodes.studioReviewAccept));
      f.resetHandler(); f.nodes.studioReviewRetry.click(); await settle(); assert.equal(f.nodes.studioReviewRetry.hidden, true); assert.deepEqual(f.writes()[0].args, f.writes()[1].args);
    } finally { f.dispose(); }
  }
});

test('a rejected reconciliation attempt cannot clear the original unconfirmed write', async () => {
  const f = fixture(); try {
    await f.ready(); f.nodes.studioReviewAddItem.click(); edit(f.nodes.studioReviewItemFields[0].description, '已写入但未确认'); let writes = 0;
    f.setHandler((operation, args, dispatch) => {
      if (operation === 'getJobReview') return dispatch(operation, args);
      writes++;
      if (writes === 1) { dispatch(operation, args); throw error('NETWORK_ERROR'); }
      if (writes === 2) throw error('SERVICE_CLOSING');
      return dispatch(operation, args);
    });
    f.nodes.studioReviewSave.click(); await settle(); f.nodes.studioReviewRetry.click(); await settle();
    assert.equal(f.states.get('job-a').review.revision, 1); assert.equal(f.nodes.studioReviewRetry.hidden, false); assert.ok(f.ui.isDisabled(f.nodes.studioReviewAccept)); assert.match(f.nodes.studioReviewError.textContent, /上次保存仍待确认/); assert.doesNotMatch(f.nodes.studioReviewError.textContent, /尚未开始/);
    f.nodes.studioReviewRetry.click(); await settle(); assert.equal(f.writes().length, 3); assert.deepEqual(f.writes()[0].args, f.writes()[1].args); assert.deepEqual(f.writes()[0].args, f.writes()[2].args); assert.equal(f.nodes.studioReviewRetry.hidden, true); assert.equal(f.states.get('job-a').review.revision, 1);
  } finally { f.dispose(); }
});

test('late reads and saves stay with their job and an older read cannot regress confirmed review', async () => {
  const f = fixture(); try {
    await f.ready(); const read = deferred(); let intercept = true;
    f.setHandler((operation, args, dispatch) => operation === 'getJobReview' && args.jobId === 'job-a' && intercept ? (intercept = false, read.promise) : dispatch(operation, args));
    const pendingRead = f.mounted.refresh(); await turn();
    f.nodes.studioReviewAccept.click(); await settle(); assert.match(f.nodes.studioReviewStatus.textContent, /已采用此候选/);
    read.resolve({ jobId: 'job-a', review: fresh(), previousAccepted: null }); await pendingRead; assert.match(f.nodes.studioReviewStatus.textContent, /已采用此候选/);
    f.nodes.studioReviewAddItem.click(); edit(f.nodes.studioReviewItemFields[0].description, '属于 A 的意见'); const save = deferred();
    f.setHandler((operation, args, dispatch) => { const result = dispatch(operation, args); return operation === 'updateResultFeedback' ? save.promise.then(() => result) : result; });
    f.nodes.studioReviewSave.click(); await turn(); await f.ready('job-b', 'job-b-1'); save.resolve(); await settle();
    assert.equal(f.nodes.studioReviewItemFields.length, 0); assert.match(f.nodes.studioReviewStatus.textContent, /尚未采用/);
    await f.ready('job-a', 'job-a-1'); assert.equal(f.nodes.studioReviewItemFields[0].description.value, '属于 A 的意见'); assert.ok(f.ui.isDisabled(f.nodes.studioReviewSave));
  } finally { f.dispose(); }
});

test('same-service reconnect preserves unconfirmed request and never replays it on another service', async () => {
  const f = fixture(); try {
    await f.ready(); f.nodes.studioReviewAddItem.click(); edit(f.nodes.studioReviewItemFields[0].description, '连接前意见'); const pending = deferred();
    f.setHandler((operation, args, dispatch) => { const value = dispatch(operation, args); return operation === 'updateResultFeedback' ? pending.promise.then(() => value) : value; });
    f.nodes.studioReviewSave.click(); await turn(); f.reconnect('http://localhost:17890'); f.resetHandler(); await f.mounted.refresh();
    assert.equal(f.nodes.studioReviewRetry.hidden, true); pending.resolve(); await settle(); assert.equal(f.writes().length, 1);
    f.reconnect(); await f.mounted.refresh(); assert.equal(f.nodes.studioReviewRetry.hidden, false); assert.ok(f.ui.isDisabled(f.nodes.studioReviewAccept));
    edit(f.nodes.studioReviewItemFields[0].description, '重连后新增文字'); f.nodes.studioReviewRetry.click(); await settle();
    assert.equal(f.writes().length, 2); assert.deepEqual(f.writes()[0].args, f.writes()[1].args); assert.ok(f.writes().every(call => call.base === 'http://localhost:17889')); assert.equal(f.nodes.studioReviewItemFields[0].description.value, '重连后新增文字');
  } finally { f.dispose(); }
});

test('connection reset and disposal invalidate queued and late reads without filling the new editor', async () => {
  const f = fixture(); try {
    const pending = deferred(); f.render(); f.setHandler(() => pending.promise); const beforeReset = f.mounted.refresh(); await turn();
    f.reconnect('http://localhost:17890'); f.resetHandler(); await f.mounted.refresh();
    pending.resolve({ jobId: 'job-a', review: review(5, [record('job-a-1', feedback('旧连接内容'))]), previousAccepted: null }); await beforeReset;
    assert.equal(f.nodes.studioReviewItemFields.length, 0);
    const later = deferred(); f.setHandler(() => later.promise); const beforeDispose = f.mounted.refresh(); await turn(); f.dispose();
    later.resolve({ jobId: 'job-a', review: review(6, [record('job-a-1', feedback('销毁后内容'))]), previousAccepted: null }); assert.equal(await beforeDispose, false); assert.equal(f.nodes.studioReviewPanel.parentElement, null); assert.equal(await f.mounted.refresh(), false);
  } finally { f.dispose(); }
});

test('ancestor adoption refreshes with unchanged current revision; adoption and navigation call only review operations', async () => {
  const f = fixture(); try {
    await f.ready(); assert.equal(f.nodes.studioReviewPrevious.hidden, true);
    f.states.get('job-a').previousAccepted = { jobId: 'job-parent', resultId: 'job-parent-2', reviewRevision: 3, recordedVia: 'agent', updatedAt: now }; await f.mounted.refresh();
    f.nodes.studioReviewPrevious.click(); await settle(); assert.deepEqual(f.navigations, [{ jobId: 'job-parent', resultId: 'job-parent-2' }]);
    f.nodes.studioReviewAccept.click(); await settle(); assert.deepEqual(f.states.get('job-a').review.feedback, []); assert.equal(f.states.get('job-a').review.acceptance.resultId, 'job-a-1');
    f.nodes.studioReviewClearAcceptance.click(); await settle(); assert.equal(f.states.get('job-a').review.acceptance.resultId, null); assert.equal(f.writes().length, 2);
    f.setNavigation(() => false); f.nodes.studioReviewPrevious.click(); await settle(); assert.match(f.nodes.studioReviewError.textContent, /此前采用的候选暂不可用/); assert.ok(f.calls.every(call => ['getJobReview', 'setAcceptedResult'].includes(call.operation)));
  } finally { f.dispose(); }
});

test('safe errors distinguish failed reads, rejected writes, unconfirmed writes and post-confirmation refresh', async () => {
  const f = fixture(); try {
    f.render(); f.setHandler(() => { throw error('NETWORK_ERROR'); }); await f.mounted.refresh(); assert.match(f.nodes.studioReviewError.textContent, /无法读取候选审阅/); assert.doesNotMatch(f.nodes.studioReviewError.textContent, /尚未确认|secret|private/);
    f.resetHandler(); await f.mounted.refresh(); f.nodes.studioReviewAddItem.click(); edit(f.nodes.studioReviewItemFields[0].description, '正确内容');
    f.setHandler((operation, args, dispatch) => { if (operation !== 'getJobReview') throw error('INVALID_INPUT'); return dispatch(operation, args); }); f.nodes.studioReviewSave.click(); await settle(); assert.match(f.nodes.studioReviewError.textContent, /格式不符合要求/); assert.equal(f.nodes.studioReviewRetry.hidden, true); assert.ok(!f.ui.isDisabled(f.nodes.studioReviewSave));
    f.setHandler((operation, args, dispatch) => { if (operation === 'getJobReview') throw error('NETWORK_ERROR'); return dispatch(operation, args); }); f.nodes.studioReviewSave.click(); await settle(); assert.match(f.nodes.studioReviewError.textContent, /保存已确认，但最新审阅读取失败/); assert.equal(f.nodes.studioReviewRetry.hidden, true); assert.ok(f.ui.isDisabled(f.nodes.studioReviewSave)); assert.doesNotMatch(f.nodes.studioReviewError.textContent, /secret|private/);
  } finally { f.dispose(); }
});

test('reload never discards text entered during its read; shared buttons retain keyboard and disabled behavior', async () => {
  const f = fixture(); try {
    f.states.get('job-a').review = review(1, [record('job-a-1', feedback('已保存'))]); await f.ready(); edit(f.nodes.studioReviewItemFields[0].description, '准备舍弃');
    const pending = deferred(); f.setHandler((operation, args, dispatch) => operation === 'getJobReview' ? pending.promise : dispatch(operation, args)); f.nodes.studioReviewReload.click(); await turn(); edit(f.nodes.studioReviewItemFields[0].description, '载入时新增文字');
    pending.resolve({ jobId: 'job-a', review: review(2, [record('job-a-1', feedback('最新已保存'))]), previousAccepted: null }); await settle(); assert.equal(f.nodes.studioReviewItemFields[0].description.value, '载入时新增文字'); assert.match(f.nodes.studioReviewMessage.textContent, /读取期间输入/);
    f.resetHandler(); f.states.get('job-a').review = review(2, [record('job-a-1', feedback('最新已保存'))]); f.nodes.studioReviewReload.click(); await settle();
    const key = (type, repeat = false) => { const event = new Event(type, { cancelable: true }); Object.assign(event, { key: ' ', repeat }); f.nodes.studioReviewAccept.dispatchEvent(event); return event; };
    assert.equal(key('keydown').defaultPrevented, true); assert.equal(f.writes().length, 0); key('keyup'); await settle(); assert.equal(f.writes().length, 1);
    key('keydown', true); key('keyup'); await settle(); assert.equal(f.writes().length, 1);
  } finally { f.dispose(); }
});
