# Gemini image provider (G04)

`createGeminiProvider()` implements the transport-independent provider contract in `../domain/README.md`. It does not read or write jobs, assets, Photoshop state or global credentials. UI and MCP must call the shared capability service; neither entry point should invoke this adapter independently.

## Configuration

The Studio settings page can save the Gemini API root, default model, timeout and a write-only API key. The professional workspace links to this form. Saving validates configuration locally and makes no provider request; a configured key has not necessarily passed remote authentication.

Companion environment variables override local settings **per field**, including an explicitly empty key. Fields owned by the environment are disabled in the form. Optional variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PXDLS_GEMINI_BASE_URL` | `https://generativelanguage.googleapis.com` | HTTPS API root; a terminal `/v1` or `/v1beta` is preserved, otherwise `/v1beta` is appended. Queries, credentials, fragments and full generateContent URLs are rejected. |
| `PXDLS_GEMINI_MODEL` | `gemini-2.5-flash-image` | Gemini image model; an optional `models/` prefix is removed. |
| `PXDLS_GEMINI_TIMEOUT_MS` | `180000` | Total fetch and response-reading timeout, 1–600000 ms. |

`PXDLS_GEMINI_API_KEY` supplies the environment-owned key. No `GOOGLE_API_KEY`, `GEMINI_API_KEY`, Codex account credentials or desktop settings are consulted. Environment changes require updating/restarting the Companion process; local form changes take effect on subsequent submissions immediately. No key or endpoint enters job snapshots or logs. `describe({model?})` contains neither. Missing/invalid configuration reports `configured: false` without contacting the service. A model may still be inspected without a key.

`settings.js` exports `createProviderSettings({rootDir,env?,fetchImpl?})`. Its `read()` returns revision, effective nonsecret settings, per-field sources, environment overrides and key-presence booleans. `update({expectedRevision,baseUrl?,model?,timeoutMs?,apiKey?,clearApiKey?})` validates and atomically replaces `gemini.json`; omitted keys are retained and deletion requires `clearApiKey:true`. Stale revisions fail with `CONFIG_REVISION_CONFLICT`; setting an environment-owned field fails with `CONFIG_OVERRIDDEN`. Clearing a local key does not remove an environment key. No read operation returns a secret.

Runtime storage is `${PXDLS_DATA_DIR}/provider-config`, defaulting to `~/.pxdls/studio/provider-config`. The dedicated directory and file use POSIX permissions 0700/0600, with exclusive temporary files, file flush and atomic rename. Linked, corrupt and oversized files fail closed. This is a private local configuration file, not OS-keychain encryption. On Windows, Node mode bits do not replace ACLs; storage inherits the user's private data-directory ACL, and directory fsync is unavailable. Do not place the runtime directory on a shared/public path or commit it to Git.

The UI-only endpoint is `GET/POST /studio/provider-settings`, with the same loopback Host/address, allowed-origin and `X-PXDLS-Agent:1` requirements as Studio. POST accepts the update object directly and is capped at 16 KiB. Configuration is absent from MCP tool registration and shared task operations. `snapshot()` captures an adapter in memory before a job is durably submitted; changing configuration while it waits or runs cannot redirect that job's inputs or alter its model/key. Reusing an existing requestId returns its original job even if configuration is now corrupt; it never binds another adapter or sends another request. New submissions fail before persistence when configuration cannot be read. Restart recovery does not replay interrupted work.

Tests may inject `{env: {}, fetchImpl, config: {apiKey, baseUrl, model, timeoutMs}}`; an explicitly present config property replaces that environment variable. The injected fetch must return a Response-compatible object with a Web ReadableStream body so response bytes can be bounded. No production path uses a fake response.

## Request behavior

One `generateContent` POST is made with the API key in `x-goog-api-key`, never the URL. Redirects are forbidden. A proxy must accept Google's generateContent schema and this header; bearer authentication and arbitrary provider protocols are not implemented.

The request includes the exact user prompt, preserve constraints, source pixels, optional selection mask and every role-labeled reference in order. IDs and roles must agree with the durable context, and mask dimensions must agree with the source. The captured mask is a lossless grayscale PNG: black is protected, white is editable and gray is partial coverage. Gemini treats it as visual guidance; only Photoshop compositing can enforce exact selection boundaries. Document names and unrelated metadata are not sent.

| Adapter profile | Optional settings | Input image limit |
| --- | --- | --- |
| `gemini-2.5-flash-image` / `gemini-2.5-flash-image-preview` | temperature 0–2, aspect ratio | 3 total |
| `gemini-3-pro-image-preview` | temperature 0–2, aspect ratio, image size `1K` / `2K` / `4K` | 14 total |
| Other explicitly configured models | temperature 0–2; automatic aspect ratio only | 3 total |

These are conservative adapter profiles, not a live model catalog. The default 2.5 profile limits inputs to three for reliable image conditioning; source and mask each count as one, leaving one reference in selection mode. The 2.5 profile rejects **all explicit `imageSize` settings**, including `1K`, because it does not send that optional API field. Unknown models are not advertised as verified: requests may be rejected remotely. `params.model` may select another model and uses that model's profile. `describe({model})` and `studio_capabilities({model})` inspect this same profile. Discovery also returns defensive `models` and `unknownModel` profiles for local UI validation. The professional workspace shows the effective draft model's options/input count, rejects excess references before import, and prevents unsupported output requests. Byte limits remain validated against actual managed bytes before fetch.

`auto` aspect ratio omits the field; unsupported settings fail before a network request rather than being silently dropped. Empty model/temperature fields and default ratio/size choices explicitly remove the corresponding saved draft parameter through `unsetParams`, so defaults remain defaults after refresh or restart.

The encoded request is limited to 20,000,000 bytes, with at most 14 MiB of combined source/mask/reference bytes and 64 megapixels per input. Response JSON is streamed with a 96 MiB bound; each output image is at most 32 MiB, all outputs together at most 64 MiB and four images. Inputs/outputs support PNG, JPEG and WebP. Byte signatures are checked here; the managed asset store performs the full dimension/integrity validation before persistence. The adapter returns `{data: Buffer, mimeType}` and deliberately omits unverified output dimensions.

Responses accept `inlineData` / `inline_data` and `mimeType` / `mime_type`. Only candidates with an explicit final `finishReason: "STOP"` (or `finish_reason`) contribute output images; missing or unspecified finish reasons remain uncertain. Prompt/output blocks and HTTP error envelopes are classified. Thought parts are ignored. Text-only output, remote URLs, data URLs embedded in text, malformed images and truncated/non-final responses are not treated as success. The adapter does not download remote image URLs. A safe response ID is returned as `provider.requestId`, otherwise the local request ID is used. No prompt, raw response text or credentials are retained in errors.

## Failure and cancellation

| Code | Meaning |
| --- | --- |
| `PROVIDER_NOT_CONFIGURED` | Missing/invalid explicit provider configuration. |
| `INVALID_INPUT` | Invalid context/assets or unsupported local settings; no request sent. |
| `PROVIDER_AUTH` | HTTP 401/403 or equivalent Gemini error envelope. |
| `PROVIDER_RATE_LIMIT` | HTTP 429 or equivalent quota error. |
| `PROVIDER_REJECTED` | Definitive HTTP input rejection or prompt/output block. |
| `PROVIDER_UNCERTAIN` | Network failure, timeout, server error or unusable/incomplete response. A paid request may already have completed. |
| `CANCELLED` | Caller cancellation; abort is propagated to fetch and bounded response reading. An already submitted remote request may still complete and charge. |

There are **no automatic retries**, including after auth, quota, timeout or network errors. Persist cancellation before aborting from the capability service. A late network completion cannot authorize reviving a cancelled job. Cancellation and timeout also settle locally if an injected fetch/reader does not cooperate with AbortSignal.

## Validation and remaining integration

Run `node --test apps/ls-studio/tests/providers*.test.cjs` from the repository root. Tests use fake fetch and complete fixture image files only. They cover request composition, settings/limits, final-status parsing, redaction, HTTP/provider failures, abort propagation and timeout without a paid call. A provider-to-asset-store test persists and reopens actual PNG/JPEG/WebP results and uses a valid grayscale PNG mask.

The local settings workflow, revision-safe parameter removal and configuration binding have fixture coverage. This module has not been validated against a paid live model or the running Photoshop configuration form. Controlled live generation, masked placement and native panel computer-use evidence remain required before main can be considered for merge. The installed Alpha runtime is untouched.
