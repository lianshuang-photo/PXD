# Local HTTP client boundary

`local-client.js` is the shared source check for the Companion server, Studio HTTP transport and Agent/Photoshop transport. The server checks it before dispatch, so legacy routes such as `/job`, `/job/context` and `/apply/last` cannot bypass the same boundary. The two transport factories also check it when embedded independently.

The check runs before CORS, preflight, UI/attachment reads, session access or host registration. A request needs both a loopback socket peer and a loopback `Host` (`localhost`, `127.0.0.1` or `[::1]`). Forwarded headers do not grant access.

| Request source | Policy |
| --- | --- |
| Local HTTP(S) Origin | Accepted, including browser requests between localhost/127.0.0.1 ports |
| Native UXP Origin (`null`, `file://`, `uxp://plugin`) | Accepted only without `Sec-Fetch-Site` |
| No Origin or fetch metadata | Accepted for local CLI/MCP and native clients |
| No Origin, browser metadata present | Accepted for local same-origin/same-site/navigation requests; cross-site requests require an explicitly local HTTP(S) `Referer` |
| Foreign Origin, opaque browser Origin or malformed fetch metadata | Rejected with 403 |

The local-referrer exception preserves browser image loads that omit Origin across localhost/127.0.0.1 aliases. Browsers control the source headers; local command-line programs can set them themselves. This boundary protects against remote web pages, not against another process already running as the user.

Photoshop executor registration, heartbeat, job polling and results additionally require a native client classification. Local web previews can inspect connection status but cannot register as the Photoshop executor. Existing client markers, host tokens and MCP tool tokens remain required on their respective routes.

Preflight permits GET/POST and each transport's explicit header list. Source/preflight rejection does not emit CORS allow headers. Accepted requests reflect their Origin; legacy responses no longer emit wildcard CORS.

`tests/local-client-security.test.cjs` exercises both standalone transports using an ephemeral HTTP server, synthetic attachments/conversations and an in-memory Photoshop bridge. `tests/server-integration.test.cjs` exercises the real server entry and legacy state with temporary data, no real Codex process and no provider key. These tests do not certify actual Photoshop/UXP compatibility; that still requires the separate host acceptance run for the proposed commit.
