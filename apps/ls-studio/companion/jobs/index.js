'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { DomainError, invariant, object, clone, id, validateDraft, validateRunSnapshot, assertTransition, jobTransitions, placementTransitions } = require('../domain/contracts');
const digest = value => createHash('sha256').update(value).digest('hex');
const MAX_STORE_BYTES = 64 * 1024 * 1024;
const own = (value, key) => Object.hasOwn(value, key);
const same = (a, b) => canonical(a) === canonical(b);
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function fields(input, allowed) {
  object(input);
  for (const key of Object.keys(input)) invariant(allowed.includes(key), 'INVALID_INPUT', 'Unsupported field: ' + key);
}
function timestamp(value) { return typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value)); }
function source(value, fallback = 'ui') {
  const result = value === undefined ? fallback : value;
  invariant(['ui', 'agent', 'system'].includes(result), 'INVALID_INPUT', 'Unknown update source');
  return result;
}
function revision(value) { invariant(Number.isSafeInteger(value) && value > 0, 'INVALID_INPUT', 'expectedRevision must be a positive integer'); return value; }
function metadata(value) {
  const copy = clone(value);
  function check(item) {
    if (!item || typeof item !== 'object') return;
    for (const [key, child] of Object.entries(item)) {
      invariant(!/^(base64|dataurl|bytes|buffer|credentials?|token|key|api[_-]?key|secret[_-]?key|url|endpoint)$/i.test(key), 'INVALID_INPUT', 'Task metadata cannot contain image bytes, credentials or request URLs');
      check(child);
    }
  }
  check(copy);
  invariant(Buffer.byteLength(JSON.stringify(copy)) <= 128 * 1024, 'INVALID_INPUT', 'Task metadata is too large');
  return copy;
}
function provider(value) { object(value, 'provider'); return metadata(value); }
function publicError(value) {
  fields(value, ['code', 'message', 'details']);
  invariant(typeof value.code === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(value.code) && typeof value.message === 'string' && value.message.length <= 4096, 'INVALID_INPUT', 'Error must be a structured public error');
  return metadata(value);
}
function validateReceipt(value, jobId) {
  object(value, 'receipt'); const result = metadata(value);
  invariant(result.jobId === jobId, 'PLACEMENT_CONFLICT', 'Receipt belongs to another job', 409);
  id(result.mutationId, 'mutationId');
  return result;
}
function syncDirectory(directory) {
  // File flush + atomic rename also works on Windows, whose Node fs API cannot
  // fsync directory handles. POSIX gets the extra parent-directory flush.
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function writeFile(file, contents) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, contents); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function validateState(state) {
  fields(state, ['schemaVersion', 'sequence', 'drafts', 'jobs']);
  invariant(state.schemaVersion === 1 && Number.isSafeInteger(state.sequence) && state.sequence >= 0 && Array.isArray(state.drafts) && Array.isArray(state.jobs), 'INVALID_INPUT', 'Unsupported task state');
  const draftIds = new Set(), jobIds = new Set(), requestIds = new Set(), resultIds = new Set();
  for (const draft of state.drafts) {
    fields(draft, ['schemaVersion', 'draftId', 'revision', 'capabilityId', 'capabilityVersion', 'params', 'context', 'source', 'createdAt', 'updatedAt']);
    id(draft.draftId); revision(draft.revision);
    invariant(draft.schemaVersion === 1 && !draftIds.has(draft.draftId) && timestamp(draft.createdAt) && timestamp(draft.updatedAt), 'INVALID_INPUT', 'Invalid stored draft');
    const checked = validateDraft(draft);
    invariant(checked.capabilityVersion === draft.capabilityVersion && same(checked.params, draft.params) && same(checked.context, draft.context) && checked.source === draft.source, 'INVALID_INPUT', 'Invalid stored draft contract');
    draftIds.add(draft.draftId);
  }
  for (const job of state.jobs) {
    fields(job, ['schemaVersion', 'jobId', 'draftId', 'requestId', 'source', 'snapshot', 'status', 'results', 'placement', 'provider', 'error', 'createdAt', 'updatedAt']);
    id(job.jobId); id(job.requestId); id(job.draftId); source(job.source);
    invariant(job.schemaVersion === 1 && !jobIds.has(job.jobId) && !requestIds.has(job.requestId) && draftIds.has(job.draftId) && own(jobTransitions, job.status) && timestamp(job.createdAt) && timestamp(job.updatedAt) && Array.isArray(job.results), 'INVALID_INPUT', 'Invalid stored job');
    fields(job.snapshot, ['capabilityId', 'capabilityVersion', 'revision', 'params', 'context']);
    revision(job.snapshot.revision);
    const checked = validateRunSnapshot(job.snapshot);
    invariant(checked.capabilityVersion === job.snapshot.capabilityVersion, 'INVALID_INPUT', 'Invalid stored capability version');
    if (own(job, 'provider')) provider(job.provider);
    if (own(job, 'error')) publicError(job.error);
    for (let index = 0; index < job.results.length; index++) {
      const result = job.results[index];
      fields(result, ['resultId', 'assetId', 'jobId', 'index', 'provider', 'createdAt']);
      id(result.resultId); id(result.assetId); provider(result.provider);
      invariant(result.jobId === job.jobId && result.index === index && timestamp(result.createdAt) && !resultIds.has(result.resultId), 'INVALID_INPUT', 'Invalid stored result');
      resultIds.add(result.resultId);
    }
    fields(job.placement, ['status', 'requestId', 'receipt', 'error', 'updatedAt']);
    invariant(own(placementTransitions, job.placement.status), 'INVALID_INPUT', 'Invalid placement status');
    if (job.placement.status !== 'not-requested') id(job.placement.requestId, 'placement requestId');
    if (own(job.placement, 'updatedAt')) invariant(timestamp(job.placement.updatedAt), 'INVALID_INPUT', 'Invalid placement timestamp');
    if (own(job.placement, 'receipt')) validateReceipt(job.placement.receipt, job.jobId);
    if (['applied', 'rolled-back'].includes(job.placement.status)) invariant(job.placement.receipt, 'INVALID_INPUT', 'Completed placement is missing its receipt');
    if (own(job.placement, 'error')) publicError(job.placement.error);
    jobIds.add(job.jobId); requestIds.add(job.requestId);
  }
  return state;
}
function createJobStore({ rootDir } = {}) {
  invariant(typeof rootDir === 'string' && rootDir.trim(), 'INVALID_INPUT', 'A task directory is required');
  let directory;
  try { fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 }); directory = fs.realpathSync(rootDir); }
  catch (_) { throw new DomainError('STORAGE_UNAVAILABLE', 'Cannot open task storage', 503); }
  const file = path.join(directory, 'state.json'), marker = path.join(directory, '.initialized');
  function write(state) {
    validateState(state);
    const serialized = JSON.stringify({ schemaVersion: 1, checksum: digest(JSON.stringify(state)), state });
    invariant(Buffer.byteLength(serialized) <= MAX_STORE_BYTES, 'STORAGE_FULL', 'Task storage reached its size limit', 507);
    const temporary = path.join(directory, '.state-' + randomUUID() + '.tmp');
    try {
      writeFile(temporary, serialized);
      fs.renameSync(temporary, file);
      syncDirectory(directory);
    } catch (_) {
      try { fs.rmSync(temporary, { force: true }); } catch (_) { /* ignored unpublished temporary file */ }
      throw new DomainError('STORAGE_UNAVAILABLE', 'Unable to persist task state', 503);
    }
  }
  function read() {
    try {
      const stat = fs.lstatSync(file);
      invariant(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= MAX_STORE_BYTES, 'INVALID_INPUT', 'Invalid task state file');
      const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
      invariant(envelope.schemaVersion === 1 && envelope.checksum === digest(JSON.stringify(envelope.state)), 'INVALID_INPUT', 'Invalid task state checksum');
      return validateState(envelope.state);
    } catch (_) { throw new DomainError('STORAGE_CORRUPT', 'Task storage is missing, corrupt or unreadable; no requests have been replayed', 500); }
  }
  // A marker distinguishes a fresh directory from a lost primary file. There is
  // intentionally no fallback to an old backup that might replay paid/host work.
  if (!fs.existsSync(file)) {
    invariant(!fs.existsSync(marker), 'STORAGE_CORRUPT', 'Task state is missing from an initialized store', 500);
    try { writeFile(marker, 'ls-studio-job-store-v1\n'); syncDirectory(directory); }
    catch (_) { throw new DomainError('STORAGE_UNAVAILABLE', 'Unable to initialize task storage', 503); }
    write({ schemaVersion: 1, sequence: 0, drafts: [], jobs: [] });
  } else {
    read();
    if (!fs.existsSync(marker)) {
      try { writeFile(marker, 'ls-studio-job-store-v1\n'); syncDirectory(directory); }
      catch (_) { throw new DomainError('STORAGE_UNAVAILABLE', 'Unable to initialize task storage', 503); }
    }
  }
  function draftFrom(state, draftId) {
    id(draftId, 'draftId'); const draft = state.drafts.find(item => item.draftId === draftId);
    invariant(draft, 'DRAFT_NOT_FOUND', 'Draft was not found', 404); return draft;
  }
  function jobFrom(state, jobId) {
    id(jobId, 'jobId'); const job = state.jobs.find(item => item.jobId === jobId);
    invariant(job, 'JOB_NOT_FOUND', 'Job was not found', 404); return job;
  }
  function expectRevision(draft, expectedRevision) {
    revision(expectedRevision);
    invariant(draft.revision === expectedRevision, 'REVISION_CONFLICT', 'Draft has changed; read its current revision before updating or running', 409, { current: clone(draft) });
  }
  function save(state, value) { state.sequence++; write(state); return clone(value); }
  function createDraft(input) {
    fields(input, ['capabilityId', 'params', 'context', 'source']);
    const checked = validateDraft(input), state = read(), now = new Date().toISOString();
    const draft = { schemaVersion: 1, draftId: 'draft-' + randomUUID(), revision: 1, ...checked, createdAt: now, updatedAt: now };
    state.drafts.push(draft); return save(state, draft);
  }
  function updateDraft(input) {
    fields(input, ['draftId', 'expectedRevision', 'params', 'context', 'source']);
    const state = read(), draft = draftFrom(state, input.draftId);
    expectRevision(draft, input.expectedRevision);
    if (own(input, 'params')) object(input.params, 'params');
    const checked = validateDraft({ capabilityId: draft.capabilityId, params: { ...draft.params, ...(input.params || {}) }, context: own(input, 'context') ? input.context : draft.context, source: source(input.source, draft.source) });
    invariant(draft.revision < Number.MAX_SAFE_INTEGER, 'STATE_CONFLICT', 'Draft revision limit reached', 409);
    Object.assign(draft, checked, { revision: draft.revision + 1, updatedAt: new Date().toISOString() });
    return save(state, draft);
  }
  function createJob(input) {
    fields(input, ['draftId', 'expectedRevision', 'requestId', 'source']);
    id(input.draftId, 'draftId'); id(input.requestId, 'requestId'); revision(input.expectedRevision);
    const from = source(input.source), state = read();
    const duplicate = state.jobs.find(job => job.requestId === input.requestId);
    if (duplicate) {
      invariant(duplicate.draftId === input.draftId && duplicate.snapshot.revision === input.expectedRevision, 'REQUEST_CONFLICT', 'requestId already identifies another draft or revision', 409);
      return { job: clone(duplicate), duplicate: true };
    }
    const draft = draftFrom(state, input.draftId);
    expectRevision(draft, input.expectedRevision);
    const checked = validateRunSnapshot(draft), now = new Date().toISOString();
    const snapshot = { capabilityId: checked.capabilityId, capabilityVersion: checked.capabilityVersion, revision: draft.revision, params: checked.params, context: checked.context };
    const job = { schemaVersion: 1, jobId: 'job-' + randomUUID(), draftId: draft.draftId, requestId: input.requestId, source: from, snapshot, status: 'queued', results: [], placement: { status: 'not-requested' }, createdAt: now, updatedAt: now };
    state.jobs.push(job); return { job: save(state, job), duplicate: false };
  }
  function transition(jobId, status, patch = {}) {
    fields(patch, ['error', 'provider']);
    const update = {};
    if (own(patch, 'error')) update.error = publicError(patch.error);
    if (own(patch, 'provider')) update.provider = provider(patch.provider);
    const state = read(), job = jobFrom(state, jobId);
    assertTransition(job.status, status);
    if (job.status === status && Object.keys(update).every(key => same(update[key], job[key]))) return clone(job);
    Object.assign(job, update, { status, updatedAt: new Date().toISOString() });
    return save(state, job);
  }
  function addResults(jobId, results) {
    invariant(Array.isArray(results) && results.length <= 64, 'INVALID_INPUT', 'Results must be an array of at most 64 images');
    const state = read(), job = jobFrom(state, jobId); let changed = false;
    // Validate the whole batch before replacing the authoritative state file.
    for (const input of results) {
      fields(input, ['resultId', 'assetId', 'jobId', 'index', 'provider', 'createdAt']);
      const resultId = input.resultId === undefined ? 'result-' + randomUUID() : id(input.resultId, 'resultId');
      const assetId = id(input.assetId, 'assetId');
      invariant(input.jobId === undefined || input.jobId === jobId, 'RESULT_CONFLICT', 'Result belongs to another job', 409);
      const existing = state.jobs.flatMap(item => item.results).find(result => result.resultId === resultId);
      if (existing) {
        invariant(existing.jobId === jobId && existing.assetId === assetId && (!own(input, 'index') || input.index === existing.index) && (!own(input, 'createdAt') || input.createdAt === existing.createdAt) && (!own(input, 'provider') || same(provider(input.provider), existing.provider)), 'RESULT_CONFLICT', 'Result ID already identifies different output', 409);
        continue;
      }
      invariant(input.index === undefined || input.index === job.results.length, 'RESULT_CONFLICT', 'Result index is not the next immutable index', 409);
      invariant(input.createdAt === undefined || timestamp(input.createdAt), 'INVALID_INPUT', 'Result timestamp is invalid');
      job.results.push({ resultId, assetId, jobId, index: job.results.length, provider: own(input, 'provider') ? provider(input.provider) : {}, createdAt: input.createdAt || new Date().toISOString() });
      changed = true;
    }
    if (!changed) return clone(job);
    job.updatedAt = new Date().toISOString();
    // Late results are retained for inspection. They never revive cancelled or
    // uncertain work, and this store never initiates a placement.
    return save(state, job);
  }
  function cancel(jobId) {
    const state = read(), job = jobFrom(state, jobId);
    if (!['queued', 'running', 'recovery-required'].includes(job.status)) return clone(job);
    assertTransition(job.status, 'cancelled');
    job.status = 'cancelled'; job.updatedAt = new Date().toISOString();
    return save(state, job);
  }
  function setPlacement(jobId, input) {
    fields(input, ['status', 'requestId', 'receipt', 'error']);
    invariant(own(placementTransitions, input.status), 'INVALID_INPUT', 'Unknown placement status');
    if (own(input, 'requestId')) id(input.requestId, 'placement requestId');
    const receipt = own(input, 'receipt') ? validateReceipt(input.receipt, jobId) : undefined;
    const error = own(input, 'error') ? publicError(input.error) : undefined;
    const state = read(), job = jobFrom(state, jobId), previous = job.placement;
    if (previous.receipt && receipt) invariant(same(previous.receipt, receipt), 'PLACEMENT_CONFLICT', 'A mutation receipt cannot be replaced', 409);
    const requestId = input.requestId || previous.requestId;
    if (previous.requestId && input.requestId && previous.requestId !== input.requestId) {
      invariant(previous.status === 'failed' && input.status === 'queued' && !previous.receipt, 'PLACEMENT_CONFLICT', 'Another placement request already owns this job', 409);
    }
    // A controller retry arriving after the host completed must see the receipt,
    // rather than re-entering queued/applying and repeating a host write.
    if (['applied', 'rolled-back'].includes(previous.status) && requestId === previous.requestId && ['queued', 'applying', 'applied'].includes(input.status)) return clone(job);
    assertTransition(previous.status, input.status, 'placement');
    if (input.status !== 'not-requested') id(requestId, 'placement requestId');
    invariant(job.status !== 'cancelled' || !['queued', 'applying'].includes(input.status), 'STATE_CONFLICT', 'Cancelled work cannot start a host mutation', 409);
    const next = { ...previous, status: input.status, ...(requestId ? { requestId } : {}), ...(receipt ? { receipt } : {}), ...(error ? { error } : {}) };
    if (input.status === 'queued' && previous.status !== 'queued') delete next.error;
    if (['applied', 'rolled-back'].includes(input.status)) invariant(next.receipt, 'INVALID_INPUT', 'Completed placement requires its mutation receipt');
    if (same(previous, next)) return clone(job);
    next.updatedAt = new Date().toISOString(); job.placement = next; job.updatedAt = next.updatedAt;
    return save(state, job);
  }
  function recover() {
    const state = read(), changed = [], now = new Date().toISOString();
    for (const job of state.jobs) {
      let interrupted = false;
      if (['queued', 'running'].includes(job.status)) {
        assertTransition(job.status, 'recovery-required');
        job.status = 'recovery-required';
        job.error = { code: 'RECOVERY_REQUIRED', message: 'Execution was interrupted; inspect its outcome before creating a new request' };
        interrupted = true;
      }
      if (['queued', 'applying'].includes(job.placement.status)) {
        // Recovery is deliberately stronger than a normal transition: even a
        // queued request may have reached a host before its acknowledgement.
        job.placement = { ...job.placement, status: 'rollback-conflict', error: { code: 'ROLLBACK_CONFLICT', message: 'Host outcome is unknown after restart; inspect Photoshop before continuing' }, updatedAt: now };
        interrupted = true;
      }
      if (interrupted) { job.updatedAt = now; changed.push(job); }
    }
    return changed.length ? save(state, changed) : [];
  }
  return {
    createDraft, getDraft: draftId => clone(draftFrom(read(), draftId)), listDrafts: () => clone(read().drafts.slice().reverse()), updateDraft,
    createJob, getJob: jobId => clone(jobFrom(read(), jobId)), listJobs: () => clone(read().jobs.slice().reverse()),
    transition, addResults, cancel, setPlacement, recover,
  };
}
module.exports = { createJobStore };
