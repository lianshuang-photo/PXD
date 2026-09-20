# G01 module contracts

The application uses CommonJS and Node's built-in test runner. `contracts.js` owns transport-independent schemas and validation; workers must propose contract changes to the integrator. This file fixes the first implementation's API; all module methods may be synchronous or return promises, and consumers always await them.

## Assets (`assets/index.js`)

Export `createAssetStore({rootDir})`. Methods: `put({data, mimeType, purpose, width, height, colorSpace, bitDepth, source}) → Asset`, `get(assetId) → Asset`, `read(assetId) → {asset, data: Buffer}`. Optional fields can be omitted. `data` is a Buffer; callers decode base64. PNG/JPEG/WebP input must be validated with file dimensions, bounded byte/pixel counts and no untrusted paths. Asset fields include `assetId`, `sha256`, `mimeType`, actual `width/height`, `purpose`, `sizeBytes`, `createdAt`; asset bytes and metadata are immutable. Content deduplication cannot silently change purpose/source metadata. Storage writes are atomic; failure must not advertise a nonexistent file. Reads verify integrity. No keys or base64 data in task records.

## Drafts and jobs (`jobs/index.js`)

Export `createJobStore({rootDir})`. Return defensive copies, store atomic versioned JSON, fail closed on corrupted data. One Companion process owns a data directory.

- `createDraft({capabilityId,params,context,source}) → CapabilityDraft`; draft has `draftId`, `revision:1`, schema version and timestamps. Empty params and null context are valid drafts.
- `getDraft(draftId)` and `listDrafts()`.
- `updateDraft({draftId,expectedRevision,params?,unsetParams?,context?,source}) → draft`; remove the named top-level parameters in `unsetParams`, then shallow merge params; replace context if provided. Removal only accepts known parameter names, at most 32 without duplicates, and cannot target a field also supplied in params. Use it to restore a model/output/temperature default; null is not a deletion marker. Return `REVISION_CONFLICT` / 409 with `details.current` on a stale write. Every accepted update increments revision; already submitted snapshots are unchanged.
- `createJob({draftId,expectedRevision,requestId,source}) → {job,duplicate}`. Validate a runnable draft; persist immutable `snapshot:{capabilityId,capabilityVersion,revision,params,context}` before dispatch. Dedupe requestId before revision checks, but reject its reuse for a different draft/revision. Initial state `queued`; results `[]`; placement `{status:'not-requested'}`; `jobId`, requestId, timestamps. No automatic execution in the store.
- `getJob(jobId)`, `listJobs()` (newest first).
- `findJobByRequestId(requestId)` returns a defensive copy or null, without executing work. The service uses it to reconcile a previously submitted request before accessing current provider configuration; `createJob` still performs the authoritative reuse/conflict check.
- `transition(jobId,status,patch={}) → job`: enforce domain transitions; patch allows only `error` (structured public error), `provider` (nonsecret request/model metadata). Cannot replace snapshot/IDs.
- `addResults(jobId,results) → job`: append immutable `{resultId,assetId,jobId,index,provider,createdAt}` objects; no state revival when cancelled. Result IDs are idempotent and cannot be overwritten.
- `cancel(jobId) → job`: queued/running/recovery-required become cancelled; completed jobs are returned unchanged. Cancellation is durable before a controller is aborted.
- `setPlacement(jobId,{status,requestId?,receipt?,error?}) → job`: enforce placement transitions separately. `receipt` is immutable once attached; never discard a successfully generated result on host failure. Concurrent different placement requests conflict. Repeated already applied request returns the existing state; never repeats a host write.
- `recover() → changedJobs`: startup moves queued/running to recovery-required, and interrupted applying/queued placements to rollback-conflict; no automatic resend to provider/host.

## Provider (`providers/index.js`)

Export `createGeminiProvider({env=process.env, fetchImpl=fetch, config?})`. `describe()` returns `{id:'gemini', configured, model, capabilities, ...}` without keys. `generate({jobId,requestId,params,context,inputs:{base:{asset,data},mask?:{asset,data},refs:[{asset,data,role}]}},{signal}) → {images:[{data:Buffer,mimeType,width?,height?}],provider:{id,model,requestId?}}`. No disk or task mutation inside the provider.

Use explicit BYOK environment `PXDLS_GEMINI_API_KEY`, optional `PXDLS_GEMINI_BASE_URL` and `PXDLS_GEMINI_MODEL`. No global credential lookup or paid calls during worker tests. A model must advertise unsupported optional settings honestly. Preserve references, mask and user constraints in the request; provider masking is advisory, host compositing enforces exact boundaries. Do not make an automatic paid retry when outcome is unknown. Classify auth, rate limit, rejection, timeout/uncertain and cancellation. Never persist/echo credentials, raw error bodies or request URLs containing keys. Use fixture fetch implementations to test parsing and abort propagation.

## Photoshop host (owned by G03)

Extend `ps-agent-014.js`'s `createExecutor(ps,encode,options)` to handle `hostOperations` plus the existing seven tools. Export reusable helpers through `ps-edit-014.js`; production requires remain local to the plugin. The worker owns capture and return modules and their tests; the integrator owns bridge validation/HTTP and HTML inclusion.

- `studio_capture({documentId,scope}) → {ok:true,documentRef,scope,transform,image:{base64,mimeType,width,height},mask?:{base64,mimeType,width,height}}`. Scope is mandatory. Return fresh full-resolution production pixels, actual selection alpha (holes/feathering), sRGB 8-bit adaptation metadata and source bounds. Reject unsupported or oversized input explicitly. Never use an enclosing rectangle as the mask. No selection in selection mode is an error.
- `studio_edit_layer({documentRef,jobId,mutationId,layerId,changes}) → {ok:true,receipt}` for name/opacity/visibility only. Changes to an existing layer must restore its old values on rollback, not delete it.
- `studio_apply_result({documentRef,jobId,mutationId,image,mask?,transform,settings?}) → {ok:true,receipt}`. New layer only. Honor source transform and mask. Unsupported grouping or formats fail explicitly. Result dimensions are checked before resize; never silently write into the current different document.
- `studio_rollback({receipt}) → {ok:true,receipt}` with `rollbackStatus:'rolled-back'` or throw `ROLLBACK_CONFLICT`. Receipt includes `mutationId`, `jobId`, source `documentRef`, `createdLayerIds`, `modifiedLayers` with before/after properties, pre/post history states, `transform` if applicable, `rollbackStatus` and time. Guard runtime ID, per-open document token and post-state before deleting created layers or restoring properties. Unknown/expired receipts cannot execute arbitrary IDs.

The executor assigns a per-runtime ID and per-open-document token; production captures and writes bind both and the observed history. Reject stale source; do not restore the user's whole history to undo an old operation. Use host modal history transactions to roll back partial failures and inspect batchPlay error descriptors. A repeated mutationId with the same operation returns its receipt, with different input is a conflict. Persisted receipts cannot be replayed blindly after a plugin reload. Fake-host validation is distinct from live Photoshop validation.

## Shared service and transports (integrator then G05/G06)

`capabilities/service.js` exports `createCapabilityService({assets,jobs,provider,bridge})`. Public operations: `discover()`, `capture({documentId,scope})`, `importAsset(input)`, `createDraft(input)`, `getDraft(id)`, `listDrafts()`, `updateDraft(input)`, `run({draftId,expectedRevision,requestId,source})`, `getJob(id)`, `listJobs()`, `cancel(id)`, `apply({jobId,resultId,requestId})`, `rollback({jobId})`. `run` returns the durable job promptly; network execution continues independently of the HTTP/MCP request. `apply` and `rollback` return the updated job. UI HTTP and MCP use these operations, never a duplicate executor. First transport is `POST /studio/call` with `{operation,arguments}` and `X-PXDLS-Agent:1`. MCP calls also require its existing tool token. Binary assets are served from managed IDs only.

MCP public names are `studio_capabilities`, `studio_capture_context`, `studio_import_asset`, `studio_create_draft`, `studio_list_drafts`, `studio_get_draft`, `studio_update_draft`, `studio_run`, `studio_list_jobs`, `studio_get_job`, `studio_cancel`, `studio_apply_result`, `studio_rollback`. Existing `photoshop_*` observation tools remain. Host operations with similar names stay internal: MCP placement routes through the shared service, never directly to host write operations.
