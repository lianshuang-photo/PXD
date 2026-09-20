# Modular PR delivery

Updated 2026-09-21. The [current merge-readiness record](evidence/2026-09-21-merge-readiness.md) records new module heads incorporating known corrections, frontend acceptance blockers and the next bounded feature. The tables below retain their historical verification scopes; their counts and successful CI do not transfer to new heads. The planning [PR #50](https://github.com/lianshuang-photo/PXD/pull/50) and broad integration [PR #51](https://github.com/lianshuang-photo/PXD/pull/51) are **closed as superseded, not merged**. Source `27fdfe1` remains a historical integration reference. The Alpha tag and installed runtime remain preserved; main is still `3c9fc7d25f0b9691346b5fdc0197a6e99305c676`.

## Initial decomposition

| PR / branch | Review scope | Declared comparison base | Local verification |
|---|---|---|---|
| [#52](https://github.com/lianshuang-photo/PXD/pull/52) `codex/v2-core` | Mechanical Alpha import, shared contracts, isolated dev launcher, CI/artifacts/release gates | `main` | 58 tests + extracted package smoke |
| [#53](https://github.com/lianshuang-photo/PXD/pull/53) `codex/v2-assets-jobs` | Immutable image assets, versioned drafts, durable jobs and replay/recovery rules | `codex/v2-core` | 28 domain/module tests |
| [#54](https://github.com/lianshuang-photo/PXD/pull/54) `codex/v2-photoshop` | Capture/mask, bound native mutations, new-layer placement, receipts and guarded rollback | `codex/v2-assets-jobs` | 37 host tests |
| [#55](https://github.com/lianshuang-photo/PXD/pull/55) `codex/v2-image-provider` | Gemini adapter, model limits, input/output validation, cancellation and redacted errors | `codex/v2-photoshop` | 16 provider tests |
| [#56](https://github.com/lianshuang-photo/PXD/pull/56) `codex/v2-recipes` | Full factory recipe normalization, search, parameters and pure compilation | `codex/v2-image-provider` | 11 catalog tests |
| [#57](https://github.com/lianshuang-photo/PXD/pull/57) `codex/v2-runtime` | One execution service, HTTP/MCP registration, Agent/Skill guidance and entrypoint wiring | `codex/v2-recipes` | 38 integration tests |
| [#58](https://github.com/lianshuang-photo/PXD/pull/58) `codex/v2-professional-ui` | Shared draft/job workspace, UXP-compatible controls and assembled status docs | `codex/v2-runtime` | 27 UI/control tests; full application 193/193 |

All seven module PRs have passed hosted CI at the heads observed before this documentation update. The table's targeted suite counts overlap and must not be summed. Every PR runs its full current branch suite and packages its own commit in hosted CI. New commits and retargeted branches require fresh checks. PRs remain drafts, and `ls-studio/computer-use` remains pending; neither approval nor successful host status is inherited from #51. The foundation reassembly preserves the original reference runtime.

The sequence is for review/merge ordering; host and provider modules do not acquire an artificial runtime dependency on each other. Import final reviewed files from the integration reference so the split includes fixes found by actual Photoshop tests, rather than reintroducing intermediate broken versions.

Every PR explains its own changes, prerequisite PR, tests and unverified host cases. Do not merge into comparison branches. Once a prerequisite reaches main, retarget the dependent PR, update its branch and renew checks/review/host evidence. No merge or successful live status is implied by creating a PR. The original reference's host evidence does not authorize a different proposed commit.

## Parallel feature PRs

Each feature has its own draft PR and uses `codex/v2-professional-ui` / #58 only as a temporary comparison base. The three feature PRs are parallel; none contains the other two features.

| PR / head | Scope | Local full-suite result | Hosted CI / host acceptance |
|---|---|---|---|
| [#59](https://github.com/lianshuang-photo/PXD/pull/59) `f4f99ea4fba8a668f333a305dcc6c727d20719f9` | Result comparison/zoom and a new editable draft derived from an immutable historical job/candidate | 209 passed, 1 launchd lifecycle test skipped, 0 failed | CI passed; host pending |
| [#60](https://github.com/lianshuang-photo/PXD/pull/60) `52739f85602ef0f29943b3eebdbd3271b6749d9d` | B05 shared user presets: factory copy, edit, import/export, revisions/history/restore/archive and explicit reference mapping | 210 passed, 1 launchd lifecycle test skipped, 0 failed | CI passed; host pending |
| [#61](https://github.com/lianshuang-photo/PXD/pull/61) `73d022fe3ee9c671b1880ea1105369d2d03027e4` | Private BYOK settings, model capabilities/reference budgets and persistent clearing of optional draft parameters | 205 passed, 1 launchd lifecycle test skipped, 0 failed | [CI passed](https://github.com/lianshuang-photo/PXD/actions/runs/35489096162); host pending |

Feature code/tests match the independently reviewed worker sources `5262436`, `2b23910` and `df7f5d1`, respectively; the inherited application README differs because these PRs use the modular base. Internal cross-review and integrator review are complete. They do **not** constitute the independent GitHub-account approval required by branch protection. These local suite counts also overlap and must not be added together.

Each feature PR has available, unexpired build artifacts bound to its full head above. Artifact availability proves packaging for that commit, not Photoshop acceptance. The required computer-use status is pending; #58's documentation head must receive renewed checks/status after this update as well.

**Do not merge a feature PR into #58's branch.** After prerequisites reach main, retarget each feature PR, update against main and renew review, CI and exact-head host evidence. Feature-specific design/implementation documents are reached through their PRs above; they do not exist in the #58 documentation tree.

## Independent acceptance and focused corrections

The [fresh-session report](evidence/2026-09-20-independent-review.md) independently verified the ten original public heads, their full local test suites and ten downloaded CI packages. It found F1 (P1: origin checks bypassed on Agent/host registration and legacy routes), F2 (P2: a cancelled job's late result loses its actual model during derivation) and H1 (native Photoshop crash during rollback, cause unresolved). Green automated checks did not detect these missing acceptance cases.

| Correction | Temporary comparison base | Verification scope |
|---|---|---|
| [#62](https://github.com/lianshuang-photo/PXD/pull/62) `4824e8e5577f5dda8f73f8bcfd80553d95a5bc28` — verified late-result model provenance | #59 `codex/v2-result-revisions` | Independent cancellation reproduction and 12-case model matrix passed; full suite 215 pass / 0 fail / 1 launchd skip, clean build and extracted smoke passed. CI passed. Host pending |
| [#63](https://github.com/lianshuang-photo/PXD/pull/63) `51fb56ff3ba67b63732a09c99c8b929cbe00c612` — shared HTTP source boundary including legacy fallback | #57 `codex/v2-runtime` | Independent original reproductions and 61-case guard/server matrix passed on source and downloaded runtime; full suite 182 pass / 0 fail / 1 launchd skip, clean build and extracted smoke passed. CI passed. Host pending |
| [#65](https://github.com/lianshuang-photo/PXD/pull/65) `e2beddc21f055f2c239d73240958f5795847456b` — SDK visibility target and restoration of changed properties only | #54 `codex/v2-photoshop` | 40 host-boundary tests, full suite 122/122, 54 JavaScript checks and clean build passed. Separate review and five independent in-memory probes found no blocker. [CI](https://github.com/lianshuang-photo/PXD/actions/runs/35516975383), actual downloaded package hashes/source identity and extracted startup passed. Exact-head host pending; this does not establish H1's cause or resolution |

F2 is resolved in the #62 correction head and F1 in #63 after independent review/retest. At that original review, #52–#61 had not yet absorbed the corrections; the [2026-09-21 record](evidence/2026-09-21-merge-readiness.md) lists the subsequent incorporation into #52/#54/#57/#59. H1 diagnosis remains unresolved. Temporary comparison branches are never merge targets. Updating any implementation head requires renewed review, CI and applicable host evidence. No main merge, release or successful host status occurred.

#65 aligns show/hide with the installed Photoshop 26 SDK's explicit, layer-only `_target`. It also avoids restoring unchanged name/opacity/visibility values while retaining complete document/history/property guards. Its stricter host fixture detects descriptors that the previous permissive stub accepted. This is a bounded compatibility correction, not proof that the prior native crash was caused by that descriptor. A later private assembly, `f0a622b162229fb99cc48cd5d45a55f5a82f17d2`, applies #65 over `8ab0e1`; it passed 261 tests / 0 failures / 1 explicitly skipped launchd lifecycle test, 80 JavaScript checks, clean build and extracted-package smoke. No aggregate PR or inherited host acceptance exists for this assembly.

A separate private correction assembly, `8ab0e1af33510600b26215e34c0c5c272088635a`, combines both fixes over `6121333` without changing the original acceptance worktree. Integration preserves provider-settings routing while applying the shared HTTP guard; the independent reviewer checked this conflict-resolution point without finding an omitted branch or guard. Integrator checks passed 255 tests / 0 failures / 1 launchd skip, 80 JavaScript/asset checks, clean release build and extracted-package smoke. The two original reproductions and the mock cross-feature E2E passed, including accepted local settings reads and rejected cross-site settings writes without a revision change. The reviewer did not rerun this assembly's full suite. It has no aggregate PR; its subsequent native evidence is recorded in the [second independent host round](evidence/2026-09-20-independent-review-round2.md).

That second round independently read Photoshop 26.0.0 / UXP 8.0.1-release and exercised actual UXP registration under the shared HTTP guard, capture, layer edit/rollback, later-edit and document-identity refusal, and actual Agent-to-UI draft updates. A separate, explicitly instrumented provider-fixture runtime retained the real host path and exercised nonrectangular selection, a hole, feathered mask placement and removal of the new layer by receipt rollback. The model response was synthetic; no real model request occurred. H1 was not reproduced in that round, but its original cause remains unknown. These results belong to `8ab0e1` and its documented fixture configuration, not the individual public heads, #65 or `f0a622b`.

## Private feature assembly

Temporary assembly `6121333dd4fe9f99a065c2d7e76920bcf88b1992` is a local integration worktree, with no aggregate PR. Initial internal assembly review completed; the subsequent [fresh independent acceptance](evidence/2026-09-20-independent-review.md) found two code defects and an unresolved native-host rollback crash. It exposes 33 MCP tools and passed 240 tests with 0 failures and 1 deliberately skipped launchd lifecycle test (241 total), syntax/asset checks for 78 JavaScript files, a clean build and smoke checks against the extracted package. The #58 foundation still exposes 24 tools; the assembly count does not describe #58 by itself.

The integrator used native Chrome and CUA on an isolated local browser runtime with synthetic images to exercise result inspection/derived drafts, preset management, model defaults/settings and 100–200% scaling. See the [exact assembly browser record](evidence/2026-09-20-feature-browser.md). This is browser interaction evidence for the assembly commit only. It supplies no Photoshop/UXP acceptance for the feature PR heads; all live statuses remain pending. B05 implementation is complete pending host acceptance, B06 is not started, and neither G09 nor M1/M2 is complete.

## Foundation verification scope

The import commit `535dd10` still matches the 180-file Alpha manifest. Foundation delivery changes bump the development version to 0.1.6, isolate its plugin identity/data, report an ephemeral server port for package smoke checks, and contain malformed URLs. Production editing modules are not wired at this stage. Automated checks and preserved-Alpha host regression do not claim M0/M1 or real generation completion.

Main protections and release evidence requirements stay in force. Module fixture tests, browser checks and full Photoshop/UXP acceptance are recorded separately.

The preserved Downloads Alpha was rechecked against all 180 manifest SHA256 entries: every file is unchanged. The annotated `ls-studio-v2-alpha.0` tag still dereferences to `535dd10629369ba4e36d67990a0f7b3cd4d2c0bc`.
