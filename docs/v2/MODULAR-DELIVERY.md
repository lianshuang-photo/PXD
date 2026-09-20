# Modular PR delivery

Updated 2026-09-20 after the user requested smaller independently reviewable PRs. PR #51 is the frozen integration reference for source `27fdfe1`, not the change to merge wholesale. The Alpha tag and installed runtime remain preserved.

## Initial decomposition

| Branch | Review scope | Declared comparison base |
|---|---|---|
| `codex/v2-core` | Mechanical Alpha import, shared contracts, isolated dev launcher, CI/artifacts/release gates | `main` |
| `codex/v2-assets-jobs` | Immutable image assets, versioned drafts, durable jobs and replay/recovery rules | `codex/v2-core` |
| `codex/v2-photoshop` | Capture/mask, bound native mutations, new-layer placement, receipts and guarded rollback | `codex/v2-assets-jobs` |
| `codex/v2-image-provider` | Gemini adapter, model limits, input/output validation, cancellation and redacted errors | `codex/v2-photoshop` |
| `codex/v2-recipes` | Full factory recipe normalization, search, parameters and pure compilation | `codex/v2-image-provider` |
| `codex/v2-runtime` | One execution service, HTTP/MCP registration, Agent/Skill guidance and entrypoint wiring | `codex/v2-recipes` |
| `codex/v2-professional-ui` | Shared draft/job workspace and UXP-compatible controls | `codex/v2-runtime` |

The sequence is for review/merge ordering; host and provider modules do not acquire an artificial runtime dependency on each other. Import final reviewed files from the integration reference so the split includes fixes found by actual Photoshop tests, rather than reintroducing intermediate broken versions.

Every PR explains its own changes, prerequisite PR, tests and unverified host cases. Do not merge into comparison branches. Once a prerequisite reaches main, retarget the dependent PR, update its branch and renew checks/review/host evidence. No merge or successful live status is implied by creating a PR. The original reference's host evidence does not authorize a different proposed commit.

## Next feature PRs

- B05: revisioned user preset management, factory copy, import/export/history/restore and explicit managed-reference mapping, shared by UI and MCP. B06 body navigation remains separate.
- M1 provider settings: private local BYOK configuration, model capabilities/reference budgets and explicit optional-parameter clearing.
- M1 result inspection: compare immutable original/candidate pixels and derive a new editable draft from a prior job without generating or placing automatically.

Implementation worktrees may start from the frozen integration reference while these base PRs are prepared. Only their feature commits are transplanted onto the declared current base before PR creation; the original large implementation is not duplicated in each review diff.

## Foundation verification scope

The import commit `535dd10` still matches the 180-file Alpha manifest. Foundation delivery changes bump the development version to 0.1.6, isolate its plugin identity/data, report an ephemeral server port for package smoke checks, and contain malformed URLs. Production editing modules are not wired at this stage. Automated checks and preserved-Alpha host regression do not claim M0/M1 or real generation completion.

Main protections and release evidence requirements stay in force. Module fixture tests, browser checks and full Photoshop/UXP acceptance are recorded separately.
