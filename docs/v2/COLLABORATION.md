# GitHub collaboration and acceptance

Confirmed by the user on 2026-09-20. The existing usable Alpha is preserved; subsequent work is developed as modules, assembled in dependency order, and submitted through PRs.

## Preserved baseline

Tag [`ls-studio-v2-alpha.0`](https://github.com/lianshuang-photo/PXD/tree/ls-studio-v2-alpha.0/apps/ls-studio) points to `535dd10`. All 180 original runtime, asset and test files match the approved Alpha 0.1.5 SHA256 manifest. Added package metadata isolates CommonJS; the new domain contract modules are inert in this baseline. The version inside the plugin remains 0.1.5. This is a source snapshot, not a new production deployment.

The preexisting download directory, installed launchd runtime and conversation data remain untouched. V2 development uses a different port/data directory. After this preservation point, active documentation is maintained in `docs/v2/`; the preserved Alpha is no longer kept as a moving documentation mirror.

## Main protection

GitHub branch protection is enabled and applies to administrators:

- PR required; at least one approving GitHub review, stale approval dismissed on a new push, and the most recent push must be approved by someone other than its pusher.
- All review discussions resolved and the branch current with its base.
- Required checks: `ls-studio-tests` and `ls-studio/computer-use`.
- Force pushes and branch deletion disabled.

The automated workflow checks module and integration tests. `ls-studio/computer-use` is a separate commit status; it stays pending until a reviewer/integrator has exercised the exact PR commit in actual Photoshop through computer use and recorded evidence. A fixture pass, a green browser UI or a screenshot of an unexercised panel cannot turn it green. The status is not auto-published by CI. An authorized reviewer still has to approve the PR; the author cannot self-approve on GitHub. Admin access is not an exception.

Evidence identifies the commit, dedicated sample, PS/UXP and Companion versions, actions taken, source/selection and returned pixels, mutation receipt, rollback behavior, failure cases, and result. Use the applicable V01–V12 cases in [VALIDATION.md](VALIDATION.md). Credentials and private user images stay local; publish a sanitized evidence report and shareable test artifacts. New code after acceptance invalidates the old result until retested. Preserve `pending` for missing live prerequisites; do not mark a failed or missing run successful.

## Delivery sequence

1. Modules receive fixed interfaces and disjoint file ownership, then implement and test independently.
2. A different agent reviews each module and the owner fixes actionable findings.
3. The integrator assembles asset/job, host and provider services, then UI/MCP/recipes. Cross-module checks run after each integration boundary.
4. After each implementation round, open a fresh independent acceptance session. It verifies the PR heads, reviews their diffs, runs cross-module E2E and exercises the applicable real Photoshop/UXP workflows through computer use. It records reproducible findings and independently retests the fixes before proposing merge.
5. PRs can be opened throughout development, including drafts. No automatic main merge or production runtime replacement.

Planning PR #50 and broad integration PR #51 are closed as superseded, not merged; their records remain historical references. Module PRs #52–#58 separate the mechanical Alpha import/contracts/delivery tooling, assets/jobs, Photoshop execution, provider, recipe catalog, shared service/MCP wiring and professional UI. Results #59, B05 presets #60 and provider settings #61 are parallel feature draft PRs, temporarily compared against #58's branch. See [modular delivery](MODULAR-DELIVERY.md) for exact heads and validation.

Until their prerequisites merge, these PRs form a temporary, explicitly declared dependency stack so each diff contains its own module. They must not be merged into an intermediate feature branch. After each prerequisite merges, retarget its dependents to `main`, update from `main` without overwriting contributors, and rerun checks, independent review and applicable exact-commit host acceptance. New product features get separate PRs and do not accumulate indefinitely in this bootstrap stack.

The private assembly `6121333dd4fe9f99a065c2d7e76920bcf88b1992` has no aggregate PR. Its internal review, automated checks and [native Chrome browser evidence](evidence/2026-09-20-feature-browser.md) use isolated synthetic material; they cannot authorize host success for another commit. Internal agent review is distinct from the independent approving GitHub account required above. Current live statuses remain pending, including after green CI and available artifacts.

The first [fresh-session acceptance](evidence/2026-09-20-independent-review.md) found two reproducible code defects and an unresolved native Photoshop crash during rollback. Focused correction PRs provide reviewable diffs; their existence does not resolve findings on older heads. Incorporate the reviewed fixes into the affected proposed implementation before allowing its merge, then renew the exact-commit checks and host evidence. Never merge into a temporary comparison branch to work around this requirement.

One acceptance operator owns Photoshop writes, plugin changes and test-service lifecycle at a time. Record host ownership and the final plugin/document/service state explicitly. Releasing that ownership after a crash does not authorize replaying an uncertain mutation or changing user documents whose recovery state is unknown.
