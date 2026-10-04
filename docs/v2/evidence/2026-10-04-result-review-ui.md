# Candidate review UI and assembly — 2026-10-04

[PR #70](https://github.com/lianshuang-photo/PXD/pull/70) adds shared candidate feedback and explicit adoption to the professional workspace at **`93add732f49eeae71795cb1fd3c1eab8083f5c72`**. Its temporary comparison base is [#69](https://github.com/lianshuang-photo/PXD/pull/69), `8a3feef68f039623efe87c8be7ef06f015280e03`. This is a focused dependent UI PR, not an aggregate or a merge into the comparison branch. No main merge, release, real-provider call or Photoshop write occurred in this delivery.

## Source, environment and ownership

| Item | Recorded scope |
|---|---|
| Module source | `93add732f49eeae71795cb1fd3c1eab8083f5c72`; clean checkout used for final tests/build and browser recovery |
| Private assembly | `3b40836ad52d0869339437b9e003eee428d5185f`, based on `51638fdaddcd017becf9d17d41235c624f54a816`; clean checkout; no aggregate PR |
| Browser service | LS Studio 0.1.6 / Node 22.22.3 on macOS 15.6.1; isolated loopback Companion 17885, dedicated agent/task/asset directories, provider unconfigured and Codex executable disabled |
| Actual UI host | Codex in-app browser; real frontend and HTTP/store operations with synthetic parent/child jobs and 384×256 grid images |
| Native host observed | Photoshop 26.0.0 was running with a dedicated synthetic document. UXP version was not freshly read; the earlier round's 8.0.1-release remains historical evidence |
| Loaded native plugin | `com.pxdls.studio.v2.frontendreview20260921`, entrypoint `pxdlsFrontendReview0`, from #66 `b5a9bc1e7701f48767ce4479cbc381216a5b4249`; it was **not** replaced with #70 or the new assembly |
| Ownership and review | `/root/review_ui_module` owned the new review module/CSS/tests; `/root` integrated comparison/controller/entrypoint and exercised the browser; `/root/lineage_review` independently reviewed final module and assembly |

The final module's served `studio-014.js`, `studio-results-014.js`, `studio-review-014.js` and its CSS matched source hashes. Browser `index.html` matched after accounting for the existing `agent-http.js` removal of three native-only PS script tags. Extracted-package smoke separately verified runtime startup, included source hashes and the browser entrypoint. Neither comparison establishes that a native plugin loaded the new source.

The user path is: select a historical task/candidate → compare it with the original input → edit multiple issues and preserve entries → save feedback → separately adopt or clear the candidate → open the exact previously adopted ancestor. Adoption records a choice; it does not generate, place, roll back or certify release acceptance.

This changes shared browser/UXP controls: text inputs, category selects, ordinary multiline textareas, buttons, selected-candidate notifications and workspace refresh/error handling. It reuses existing fonts, tokens, scale and button keyboard/disabled handling. Backend review schemas and Photoshop executors are unchanged. The [module contract](https://github.com/lianshuang-photo/PXD/blob/93add732f49eeae71795cb1fd3c1eab8083f5c72/docs/v2/RESULT-REVIEW-UI.md) describes local edit lifetime and connection isolation.

## Automated and independent verification

| Tested source | Observed result |
|---|---|
| Final module `93add732f49eeae71795cb1fd3c1eab8083f5c72` | `PXDLS_SKIP_LAUNCHD_TEST=1 npm test`: **264 pass / 0 fail / 1 explicit launchd skip**. `npm run check`: **74 JavaScript/resource/version checks**. Clean release-mode build and extracted-package smoke passed |
| Private assembly `3b40836ad52d0869339437b9e003eee428d5185f` | Same commands: **320 pass / 0 fail / 1 explicit launchd skip**, **84 checks**, clean build and extracted-package smoke passed |
| Final module CI | [Run 37172527022](https://github.com/lianshuang-photo/PXD/actions/runs/37172527022) passed all platform/Node jobs, distributable build/smoke and `ls-studio-tests` on `93add732f49eeae71795cb1fd3c1eab8083f5c72` |
| Independent module review | No remaining blocker on final source. Controller/mounted regressions **30/30** passed. Earlier module/mounted checks overlap with these/full-suite totals and are not additive |
| Independent assembly review | No remaining blocker on `3b40836ad52d0869339437b9e003eee428d5185f`; **49/49** targeted regressions passed. Original preset/provider modules and all old/new test coverage retained |

Review found and fixed local edits being lost when users returned to the original text during an in-flight save/delete; a pre-deduplication refusal incorrectly clearing an earlier uncertain request; malformed conflict data incorrectly resolving uncertainty; manual refresh double-reporting; and a late old-connection read error reaching a new workspace. A valid matching-job, later-revision conflict from an exact retry may resolve a never-applied request because the atomic service checks deduplication before revision comparison. Missing/malformed details or refusal before deduplication retain the uncertain original request.

The private assembly cherry-picked module commits `7e98d4d80e9fec9819c164a930c358880e970eb7`, `ff95671cd2e6fd4a8162f4cb6c455ab375ece220` and `93add732f49eeae71795cb1fd3c1eab8083f5c72` as `27a5bed`, `0c037c8` and `3b40836`. Conflict resolution preserves presets/provider/review includes, existing module mount/disposal/polling, the new guarded `refreshWorkspace`, and both provider-specific and review/recovery fixtures. The separate reviewer checked those integration points. No browser or native result is claimed for this newly assembled source.

## Actual browser execution

All rows below use the final `93add732…` source unless explicitly labelled otherwise. Tests called the production local metadata service; completed jobs were seeded offline through the normal stores, and lineage through real `deriveDraft`. No provider generation or PS capture/apply/rollback was used to make the fixture.

| ID | Actual operation | Observed UI and stored result | Scope/result |
|---|---|---|---|
| B1 | Load two issues and two preserve entries, edit Chinese text and category; Enter in a normal feedback textarea | Full structured content displayed; Enter inserted a newline; selection/focus updated | Passed in browser; not native IME |
| B2 | Switch candidates and return before saving | Original candidate's unsaved edits remained; saving addressed the selected result identity | Passed |
| B3 | Save feedback, press Space to adopt, press Enter to clear | Separate decision status changed and persisted without rewriting feedback | Passed |
| B4 | Open previously adopted version | Navigated to parent candidate 2 exactly, rather than another candidate sharing its task | Passed |
| B5 | Add/save/adopt candidate 2, then delete its feedback | Feedback disappeared while adoption remained; return to child candidate 1 and explicit adoption persisted | Passed |
| B6 | Stop service, click actual workspace Refresh, attempt Save, restart same source/data, explicitly retry the original request and refresh | Safe read error and separate unconfirmed-save state; local feedback retained; retry confirmed the save; recovery cleared the obsolete read error | Passed |
| B7 | Dark/light × 100%/200% × 560×900/360×800; scroll through review fields to final actions | Review area visually checked across all eight combinations. At 200% narrow, final Save was reached and used; body width/content 346/346 and review width/content 306/306, without horizontal overflow | Passed within browser scope; this is not whole-product/native acceptance |
| B8 | Another HTTP client updates feedback while the browser has local edits | Conflict preserved local text and showed current saved feedback; explicit reload recovered | **Earlier `7e98d4d80e9fec9819c164a930c358880e970eb7` browser source only.** Final automated coverage passed; the same live conflict sequence was not repeated after the final refresh fixes |

Select value changes were exercised; an attempted popup screenshot did not capture the expanded menu, so popup visual acceptance is unverified. Chinese text entry and browser key operations do not establish native input-method composition behavior.

Final readback recorded two succeeded jobs, both with placement `not-requested`, provider unconfigured, child review revision 15, one saved candidate-1 feedback containing two issues/two preserve entries, and child candidate 1 explicitly adopted. Parent candidate 2 remained adopted. The retained JSON and screenshots contain only synthetic test material and remain local:

- `review-ui-browser-state.json`: final metadata readback bound to the module source.
- `review-ui-adopted-browser.jpg`: 350×200 browser excerpt showing the application/review context and “候选 1 · 已采用此候选”; 9,219 bytes; SHA256 `194342410b077c731562d7d3bde1c910a61cc45e60584a79d3bc694936374f06`. This is a visible-state excerpt, not evidence of native input or all executed steps.
- Earlier `review-ui-browser.jpg` shows only the header and review title and is **not** evidence of adoption.

Browser viewport overrides were reset, the temporary review tab was closed and the isolated service stopped. Alpha service 17880, the Downloads snapshot and Alpha tag were not changed. Photoshop remained open on dedicated synthetic material.

## Native panel matrix and remaining gate

The user had opened Photoshop/the plugin, but fresh computer-use observation still exposed only the main document canvas and standard Photoshop controls, without an operable LS panel surface. Earlier menu/window actions did not expose it. Bridge registration on the separately loaded #66 source proves connectivity only; it neither exercises #70 nor proves panel layout/input. The unresolved question about floating/docked placement was not treated as an answer. No workspace reset, unsafe Photoshop restart or permission expansion was performed.

| Theme | Scale | Normal native panel | Narrow native panel |
|---|---|---|---|
| Light | 100% | Unverified; dimensions unavailable | Unverified; dimensions unavailable |
| Light | 200% | Unverified; dimensions unavailable | Unverified; dimensions unavailable |
| Dark | 100% | Unverified; dimensions unavailable | Unverified; dimensions unavailable |
| Dark | 200% | Unverified; dimensions unavailable | Unverified; dimensions unavailable |

Native text/textarea focus, font/height, select open/selected/disabled states, mouse/Enter/Space, Chinese IME, final-action scrolling and failure/recovery feedback all remain unverified for #70. Password/number/recipe controls are not introduced by #70; their existing native acceptance remains pending on the relevant module/assembly. No native acceptance is waived by this distinction.

[VALIDATION.md](../VALIDATION.md) V05/V08/V10 are partly supported by this module's metadata and browser/offline cases: separate decision semantics, original-request recovery and shared revision state. This does not complete actual Agent-to-UI/native acceptance, real-provider COS evaluation, V11/V12 or M1. A full reload/dispose still discards the local unsaved/pending journal; same-service reconnect retains it within the mounted session, and different-service requests cannot replay it.

The next acceptance work is to make the native panel accessible, load a verified candidate source/build and execute its real controls and workflow; then continue the remaining M1 real-provider/Agent/Photoshop cases. Do not start M2 or call the current assembly a released product. All affected `ls-studio/computer-use` statuses remain pending.

A fresh protection read still requires `ls-studio-tests`, `ls-studio/computer-use`, one independent approval, approval after the latest push, stale-review dismissal and administrator enforcement. #52 remains `REVIEW_REQUIRED`/`BLOCKED`, and main remains `3c9fc7d25f0b9691346b5fdc0197a6e99305c676`. Internal independent code review is not independent GitHub-account approval. Dependent PRs must be retargeted after prerequisites land and receive renewed exact-source checks/review/host evidence. No merge or release is eligible from this report.
