# Shared candidate review delivery — 2026-10-04

[PR #69](https://github.com/lianshuang-photo/PXD/pull/69) delivers the next M1 backend workflow at **`8a3feef68f039623efe87c8be7ef06f015280e03`**. Its declared comparison base is #68, `3975d8b3073aeeea6f4d8abe4501eb5c28c2a531`; the base is not a merge destination. No main merge, release, installed Alpha replacement or real-provider request occurred.

## Scope and independent review

The shared task store now records candidate feedback separately from explicit accepted-candidate selection. The HTTP and MCP entry points use the same review revision, stable request deduplication and persistence. Later retries return the current review and original applied revision without repeating a previous write. A read operation follows immutable revision lineage to locate the nearest ancestor that still has an accepted result. Selecting or clearing an accepted candidate does not generate, apply, roll back, alter execution state, or authorize release acceptance. Recording an Agent entry point does not prove human aesthetic approval.

Two workers owned disjoint storage/domain and service/transport files. A separate reviewer inspected the final 14-file module and callers. The reviewer found that malformed MCP success responses could incorrectly acknowledge a review write. The final source checks acknowledgement shape, job identity, review/applied revision and, where the original revision is still current, the requested content. Malformed acknowledgements are treated as unconfirmed saves; legitimate duplicate replies can retain the first UI attribution or contain a later review. The reviewer reproduced the issue offline and rechecked the fix with no remaining blocker.

Schema validation also now requires a declared property to be an own property of the schema's properties object; prototype names such as `toString` cannot masquerade as allowed feedback fields. The independent reviewer confirmed the existing additional-properties fallback and ordinary declared fields still work.

No browser or plugin controls were added. `studio_get_job_review`, `studio_update_result_feedback` and `studio_set_accepted_result` are available at the shared service/MCP boundary. Existing get/list task operations expose saved review state. The domain README, two project tool-use instructions and [the module contract](https://github.com/lianshuang-photo/PXD/blob/8a3feef68f039623efe87c8be7ef06f015280e03/docs/v2/RESULT-REVIEW.md) document inputs, limits, public errors and recovery. Candidate-workspace UI remains a subsequent feature PR; this backend delivery does not complete M1.

## Verified source combinations

| Tested source | Actual result |
|---|---|
| Module `8a3feef68f039623efe87c8be7ef06f015280e03` | Full local suite **244 pass / 0 fail / 1 explicitly skipped launchd test**; 72 JavaScript/resource/version checks; clean-source build and extracted-runtime/startup/source-checksum smoke passed. Independent final-source review had no remaining blockers. |
| Private assembly `51638fdaddcd017becf9d17d41235c624f54a816` | Full suite **300 pass / 0 fail / 1 explicitly skipped launchd test**; 82 JavaScript/resource/version checks; clean-source build and extracted smoke passed. No aggregate PR. |
| Hosted CI for module | [Run 37168958114](https://github.com/lianshuang-photo/PXD/actions/runs/37168958114) completed successfully for `8a3feef68f039623efe87c8be7ef06f015280e03`. |
| Browser / real Photoshop backend / native panel on this module or assembly | **Unverified.** No corresponding computer-use success was recorded. |

The automatic tests use dedicated small image fixtures, temporary real stores and loopback HTTP/MCP. Provider and host calls are forbidden in review-flow cases. Tests cover initial revision races, interleaved UI/Agent updates, stale revisions, foreign candidates, cancelled late results, feedback deletion, acceptance/clear, restart and original-request recovery after later edits, corrupted storage, ancestor lookup, malformed acknowledgements and immutable execution inputs/results/placement. Independent targeted suites overlap with these totals and are not additive.

The private assembly applies the module to `9d8c43eeb38d2fc50a89b43ec79f15bfe336cd63`. Five merge-conflict points were resolved by retaining both implementations: parameter clearing helpers and review helpers; all preset source handling and revision-aware recipe reads; review reads/writes; and the new three-tool discovery assertions alongside the assembled total of 36 tools. The separate reviewer verified these points and the unchanged duplicate-run guard/provider snapshot behavior. Assembly results cannot be transferred to a different module head.

## Remaining gates and next scope

The [frontend follow-up](2026-10-04-frontend-followup.md) belongs to #66 `b5a9bc1e7701f48767ce4479cbc381216a5b4249`, not either source above. It records actual browser form recovery and a connected PS bridge, while the computer-use surface still did not expose an operable native floating panel. Native theme/size/control/keyboard/IME checks remain unverified.

The next UI feature should add feedback editing and explicit acceptance beside the existing candidate comparison, with independent unsaved-feedback/conflict state and the current review revision included in refresh detection. It must consume these shared operations. It must not create a parallel UI state store, imply the Agent independently certified user approval, or trigger automatic generation/Photoshop placement from an acceptance update.

Real-provider COS sample evaluation, actual final-source UI/Agent/Photoshop workflows and independent GitHub approval remain outstanding. `ls-studio/computer-use` remains pending; automated success and source review do not bypass main protection or authorize a release.
