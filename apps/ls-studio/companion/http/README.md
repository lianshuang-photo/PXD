# Local HTTP client boundary

`local-client.js` owns source checks for the foundation Companion server and its Agent/Photoshop transport. It is the foundation-applicable part of the fix from PR #63 (`51fb56f`); this module does not add the later Studio runtime or HTTP transport. The server checks every route before dispatch, and `createAgentHttp` repeats the check when embedded independently.

## Affected paths and callers

| Surface | Callers and compatibility contract |
| --- | --- |
| `/health`, `/recipes/*`, `/job/*`, `/plan`, `/compile`, `/apply*`, `/lastApplyMeta`, `/atom/*` | `plugin/main-014.js` and retained `main.js` use local fetch, with Content-Type on POST. These legacy routes now share the source boundary and retain their existing request bodies and response/state formats. |
| `/agent/*`, `/ui/*` | `plugin/agent-014.js`, native UXP and local browser previews; API calls keep `X-PXDLS-Agent: 1`, public UI and attachment GETs keep their existing marker-free access. |
| `/photoshop/*` | `plugin/ps-agent-014.js` registers/polls/reports with the client marker and host token; `photoshop-mcp.cjs` calls tools with the client marker and tool token. Local web pages can inspect status but cannot register, poll or report as the executor. |

No controls, layouts, themes, storage formats, business operations or public tool schemas change. This module owns source/preflight validation and the corresponding server/Agent wiring; existing marker and token checks still own route authorization. The obsolete permissive `allowedOrigin` helper has no callers and is no longer exported.

## Source policy

Checks run before CORS, preflight, UI/attachment reads, session access or host registration. A request needs both a loopback socket peer and a loopback `Host` (`localhost`, `127.0.0.1` or `[::1]`). Forwarded headers do not grant access.

| Request source | Policy |
| --- | --- |
| Local HTTP(S) Origin | Accepted, including browser requests between localhost/127.0.0.1 ports |
| Native UXP Origin (`null`, `file://`, `uxp://plugin`) | Accepted only without `Sec-Fetch-Site` |
| No Origin or fetch metadata | Accepted for local CLI/MCP and native clients |
| No Origin, browser metadata present | Accepted for local same-origin/same-site/navigation requests; cross-site requests require an explicitly local HTTP(S) `Referer` |
| Foreign Origin, opaque browser Origin or malformed fetch metadata | Rejected with 403 |

The local-referrer exception preserves browser image loads that omit Origin across localhost/127.0.0.1 aliases. Browsers control the source headers; local command-line programs can set them themselves. This boundary protects against remote web pages, not against another process already running as the user. Native classification requires absent `Sec-Fetch-Site`; `Sec-Fetch-Mode` alone does not identify a browser because CLI fetch also emits it.

Photoshop executor registration, heartbeat, job polling and results additionally require native classification, before even preflight is accepted. Source rejection returns a fixed safe message with HTTP 403 and performs no business dispatch. The internal errors are `LOCAL_CLIENT_REQUIRED`, `ORIGIN_REJECTED` and `PREFLIGHT_REJECTED`; the existing HTTP `{ok:false,error}` shape is preserved.

Preflight permits GET/POST and each route family's explicit header list: Content-Type for legacy routes; Content-Type, X-PXDLS-Agent, X-PXDLS-Host and X-PXDLS-Tool for Agent/Photoshop. Preflight itself does not require a client marker or token. Source/preflight rejection emits no CORS allow headers. Accepted requests reflect their Origin; legacy responses no longer emit wildcard CORS or credential permission.

## Verification scope

`tests/local-client-security.test.cjs` exercises the standalone Agent transport with an ephemeral HTTP server, synthetic attachments/conversations and an in-memory Photoshop bridge. `tests/server-integration.test.cjs` exercises the real server entry and all legacy route families with temporary data, a disabled Codex executable and no provider key. Assertions cover denial before reads/writes, unchanged synthetic job/executor state, malformed request survival, local browser compatibility, native/CLI requests and existing marker/token requirements.

Automated transport tests and extracted-package smoke do not certify actual browser behavior or Photoshop/UXP compatibility. The integrator must exercise browser preview/session/image access and the native executor registration, polling, heartbeat, result and observation-tool workflow on the exact proposed source commit. Native UI layout verification is not newly affected by this backend-only change, but existing PR #52 host gates still apply. No real provider, user data, installed Alpha service or launchd lifecycle is used by these regressions.
