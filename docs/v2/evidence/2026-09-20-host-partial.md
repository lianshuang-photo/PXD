# Partial real-host validation — 2026-09-20

**Result: incomplete; not a successful computer-use gate.** This report records real operations for `f0cd2e5619a8819195377bc0a7a8cb32d85ae3af`. Later commits must be assessed separately. No successful host status, merge, release publication or installed Alpha replacement was performed.

## Environment and isolation

- Photoshop 2025 **26.0.0**, UXP **8.0.1**, macOS.
- LS Studio **0.1.6**, generated development plugin `com.pxdls.studio.v2.dev`, separate Companion on loopback port 17881 with isolated ignored data. The generated manifest recorded the commit above with `dirty: false`.
- Dedicated synthetic RGB8 checker/gradient image, **320×240**, with one duplicated raster layer and its background. Existing user documents were not edited.
- Computer-use actions used native Chrome for the shared professional UI and Photoshop for selecting, inspecting and manually modifying the synthetic document. UXP Developer Tool loaded the actual development plugin. The bridge calls ran in real Photoshop.
- The floating UXP panel itself was not exposed by the available computer-use surface. These results do not establish native panel layout, text input, Enter handling or scaling acceptance.
- Image provider was unconfigured. No real image generation or paid provider request was made.

## Observed cases

| Case | Actual procedure and observation | Coverage |
|---|---|---|
| Explicit full-document input | Clicked the explicit full-document capture action; a 320×240 source asset and real layer IDs 3/1 were returned from Photoshop. | Passed for this RGB8 sample |
| Feathered selection | Captured a real rectangular selection after applying 5 px feather in Photoshop. Returned bounds `(27,21)–(277,209)`, size 250×188; decoded mask contained 144 black, 28,260 white and 18,596 intermediate-gray pixels. | Real feather capture passed; holes/lasso and generated-result edge placement not tested |
| No selection | Deselect in Photoshop, then click selection capture. UI reported `NO_SELECTION`, asking to select a range or explicitly use full-document mode; no silent full-document replacement occurred. | Passed |
| Combined existing-layer update | From a fresh capture, changed layer 3 from `图层 1`, 100% opacity to `LS V2 Combined Check`, 60%. UI reported completion; Photoshop window title/layer panel and opacity control confirmed both values. | Passed |
| Receipt-based rollback | Clicked rollback for that job. UI reported rolled back; Photoshop restored `图层 1`, 100% opacity, and retained both original layers. Receipt contains no created layers and the expected before/after properties. | Passed |
| Stale source | Tried another run using the old snapshot after rollback. UI refused with `LAYER_CONTEXT_CONFLICT` and required recapture; no new write was dispatched. | Passed for changed history; cross-document close/reopen not tested |
| Subsequent manual change | Recaptured, executed another combined update, then manually changed opacity from 60% to 80% in Photoshop. Rollback reported `ROLLBACK_CONFLICT`; Photoshop remained at 80%. | Passed |
| New-layer result placement | No actual generated result was available. | Not run |
| UI ↔ actual Codex turn | Shared service/transport tests passed; no actual Agent turn was used for this live run. | Not run |

The synthetic feather mask is retained as [feather-mask.png](feather-mask.png). Its SHA256 is `3d83d6ea09430e98c2c5787a0076909c12ea751a3903f1a66145b82411c45062`. No user photograph is included. Sanitized native outcome data are in [native-results.json](native-results.json); full private runtime state remains local.

## Defects found and retested

Earlier real-host runs failed when a single Photoshop `set` command carried both layer name and opacity. Name-only and opacity-only changes succeeded, isolating the multi-property behavior. Rollback also failed when it tried to restore multiple properties in that form. `b088846` splits property commands inside the same history transaction and keeps the actual readback check; both combined update and rollback passed on the tested commit above.

UXP also reconstructed thrown callback errors, losing domain codes. The modal wrapper now preserves trusted errors while normalizing arbitrary native exceptions. Development diagnostics show bounded, sanitized stages; production does not expose native payloads. `NO_SELECTION` was observed on the real host after this fix. A different agent independently reviewed these changes; the relevant host suites passed 43 tests.

## Automated and distribution evidence

At the tested commit: **193/193** local tests passed (no skips), including isolated launchd and 11 release-gate tests; syntax/manifests covered 67 JavaScript files. The clean 0.1.6 combined ZIP passed extracted startup, browser entrypoint and source-hash verification; the UXP source ZIP passed independent ZIP validation.

The first hosted Linux/macOS/Windows and Node 18/22/24 matrix plus package build [passed on 469a608](https://github.com/lianshuang-photo/PXD/actions/runs/35464311154). Current-head results and downloadable artifacts are attached to [PR #51](https://github.com/lianshuang-photo/PXD/pull/51); an earlier successful run does not authorize a later commit.

## Outstanding acceptance

G08 and full M0/M1 acceptance remain open: actual provider generation and PNG/JPEG placement, generated-edge behavior for holes/feather, cross-document identity/reopen, cancellation and uncertain outcomes under actual host/provider conditions, UI↔Agent handoff, native UXP panel input/scaling and a COS sample with a judged result. This partial Markdown report is intentionally not a passing V01–V12 release evidence record.
