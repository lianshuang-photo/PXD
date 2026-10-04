# Frontend follow-up — 2026-10-04

This follows the user's report that the Photoshop panel is now open. The application was inspected again; the earlier inability to control the floating panel was not treated as proof that the user had not opened it. **Browser checks below passed in their stated scope. Native-panel acceptance is still unverified.** No main merge or real-provider request occurred.

## Tested source and isolation

- Candidate: PR #66, `b5a9bc1e7701f48767ce4479cbc381216a5b4249`, clean source checkout.
- UDT plugin: **LS Studio Frontend Review**, ID `com.pxdls.studio.v2.frontendreview20260921`; generated `DEV-SOURCE.json` records the same commit and `dirty:false`. The existing development manifest and runtime-config overrides use port **17885**. This is not #68 or the full M1 assembly.
- Isolated Companion: the same #66 source, bound to `127.0.0.1:17885`, with dedicated `.local/acceptance-20261004/{agent,studio}` state. Gemini environment overrides were removed. Codex was intentionally disabled with `/usr/bin/false` for form-only testing; no real Agent conversation is claimed.
- Native host: Photoshop 26.0.0, with the already-open dedicated `review-synthetic.png` (384×256). No capture, pixel mutation, save or user-photo upload was performed in this follow-up.
- Installed Alpha, port 17880, Downloads snapshot and main were not changed.
- After browser testing, the temporary browser viewport/tab was reset/closed and the task-owned Companion was stopped. The test data remains only in its ignored local directory; Photoshop was left running.

## Native observation and remaining obstacle

Computer use obtained the Photoshop document window, inspected **Plugins → LS Studio Frontend Review**, invoked that panel entry, and used **Window → Arrange → Bring All to Front**. Both accessibility output and screenshots still exposed only the main document window, not an operable plugin panel. No workspace reset, Photoshop restart or permission expansion was used.

After the isolated Companion started, its read-only `/photoshop/status` reported `connected:true`, `host:Photoshop`, `version:26.0.0` and the seven registered observation tools. The browser settings also displayed the connected host. This confirms a plugin bridge connection; it does not establish that native controls were exercised or visually correct. The user was asked whether the panel was floating and, if so, to dock it into the main Photoshop window so the available computer-use surface could access it.

## Actual browser interaction

CUA opened an isolated in-app browser at `http://127.0.0.1:17885/ui/`. The page is served by the same candidate Companion. The following actions used the rendered controls; DOM snapshots and screenshots were inspected during the interaction.

| Case | Observation |
|---|---|
| Settings at 360×800, 100%, dark | Provider fields, status and actions were readable, without provider/Codex section overlap. This is browser rendering only. |
| Valid configuration save | Entered a deliberately fake test Key and timeout `120000`. The UI showed `配置已保存。`, cleared the Key input, and distinguished locally provided configuration from unverified online authentication/model availability. No generation was requested. |
| Invalid save and recovery | Changed timeout to `0`, saved, and observed `配置内容无效，请检查 API 地址、模型、Key 和超时设置。`. Reload restored `120000`. The invalid value did not replace persisted configuration. |
| Clear test Key | Clicking the clear action showed `本地 Key 已删除。`; the clear button became disabled and the UI reported that generation was unavailable without a Key. The private config was later corroborated to contain no `apiKey` field. |
| 200%, light, 360×800 | Settings number/password fields and professional model/number/select fields remained readable and focusable; vertical scrolling reached them. These two observed theme/scale combinations are not the full required native matrix. |
| Shared draft editing | Created a dedicated draft, entered Chinese text, pressed Shift+Enter, entered numeric `0`, selected `1:1`, and saved. UI showed revision 2 with the explicit numeric and ratio values. Then cleared the number, restored `模型默认`, saved and reloaded; UI showed revision 3, empty override/default selector and `已读取最新共享版本`. |
| Read failure and service recovery | Stopped only the task-owned test Companion and clicked reload. The UI retained field content and showed `无法连接本机服务，未能读取配置。请检查服务和连接地址，然后重新载入。`, rather than a write/unknown-submit message. Restarted the same isolated source and reloaded; saved timeout `120000` returned and the connection recovered. |

A read-only check of the isolated persisted state corroborated **one draft at revision 3**, containing only the synthetic prompt (including its newline), `context:null`, and **zero jobs**. The configuration was at revision 2 with timeout `120000` and no API Key. Restoring parameter defaults did not leave stale numeric/ratio overrides. Chinese text insertion and Shift+Enter are not evidence of a native Chinese IME candidate-confirmation test.

## Scope and gates

- Automated: no candidate code changed or full suite rerun in this browser follow-up; prior exact-source automated/CI results retain their original scope.
- Browser: the successful and failed/recovered form/draft paths above were exercised. Other theme/size combinations, generated candidates and actual Agent sends were not covered here.
- Photoshop backend: bridge connection observed only; no capture, edit, placement or rollback claimed for this source.
- Native panel: visual controls, keyboard/IME, password masking, select expansion, light/dark × 100%/200% × normal/narrow, and end-to-end native interactions remain unverified.
- Full M1: real-provider COS sample, shared UI/Agent generation/revision workflow, applicable final-source host operations and independent GitHub approval remain outstanding.

`ls-studio/computer-use` stays **pending**. Browser observations and a connected bridge do not authorize changing it to success or merging the dependent PR stack.
