# Gemini image provider (G04)

`createGeminiProvider()` implements the transport-independent provider contract in `../domain/README.md`. It does not read or write jobs, assets, Photoshop state or global credentials. UI and MCP must call the shared capability service; neither entry point should invoke this adapter independently.

## Configuration

Set `PXDLS_GEMINI_API_KEY` in the environment of the Companion process. Optional variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PXDLS_GEMINI_BASE_URL` | `https://generativelanguage.googleapis.com` | HTTPS API root; a terminal `/v1` or `/v1beta` is preserved, otherwise `/v1beta` is appended. Queries, credentials, fragments and full generateContent URLs are rejected. |
| `PXDLS_GEMINI_MODEL` | `gemini-2.5-flash-image` | Gemini image model; an optional `models/` prefix is removed. |
| `PXDLS_GEMINI_TIMEOUT_MS` | `180000` | Total fetch and response-reading timeout, 1–600000 ms. |

No `GOOGLE_API_KEY`, `GEMINI_API_KEY`, Codex account credentials, user files or desktop settings are consulted. An already running Companion needs its own environment updated by the operator before these settings take effect. Do not put real keys in source files, job parameters or logs. `describe()` contains no key or endpoint. Missing/invalid configuration reports `configured: false` without contacting the service.

Tests may inject `{env: {}, fetchImpl, config: {apiKey, baseUrl, model, timeoutMs}}`; an explicitly present config property replaces that environment variable. The injected fetch must return a Response-compatible object with a Web ReadableStream body so response bytes can be bounded. No production path uses a fake response.

## Request behavior

One `generateContent` POST is made with the API key in `x-goog-api-key`, never the URL. Redirects are forbidden. A proxy must accept Google's generateContent schema and this header; bearer authentication and arbitrary provider protocols are not implemented.

The request includes the exact user prompt, preserve constraints, source pixels, optional selection mask and every role-labeled reference in order. IDs and roles must agree with the durable context, and mask dimensions must agree with the source. The captured mask is a lossless grayscale PNG: black is protected, white is editable and gray is partial coverage. Gemini treats it as visual guidance; only Photoshop compositing can enforce exact selection boundaries. Document names and unrelated metadata are not sent.

| Adapter profile | Optional settings | Input image limit |
| --- | --- | --- |
| `gemini-2.5-flash-image` / `gemini-2.5-flash-image-preview` | temperature 0–2, aspect ratio | 3 total |
| `gemini-3-pro-image-preview` | temperature 0–2, aspect ratio, image size `1K` / `2K` / `4K` | 14 total |
| Other explicitly configured models | temperature 0–2; automatic aspect ratio only | 3 total |

These are conservative adapter profiles, not a live model catalog. The default 2.5 profile limits inputs to three for reliable image conditioning; source and mask each count as one, leaving one reference in selection mode. The 2.5 profile rejects **all explicit `imageSize` settings**, including `1K`, because it does not send that optional API field. Unknown models are not advertised as verified: requests may be rejected remotely. `params.model` may select another model and uses that model's profile. `auto` aspect ratio omits the field; unsupported settings fail before a network request rather than being silently dropped.

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

This module has not been validated against a paid live model or a running Photoshop plugin. Final integration still needs the shared service, explicit operator-provided BYOK configuration, a controlled live generation, masked placement in Photoshop and recorded computer-use evidence before main can be considered for merge. The existing Alpha runtime is untouched by this module.
