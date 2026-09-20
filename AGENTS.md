# PXD collaboration

- Preserve the LS Studio Alpha runtime at tag `ls-studio-v2-alpha.0`. Do not change the installed Alpha service or the user's Downloads snapshot as part of normal development.
- Work on feature branches and submit PRs. Never push directly to `main`, force-push it, or merge a PR automatically.
- A merge requires strict independent review, passing automated checks, resolved discussions, and computer-use acceptance on the actual Photoshop/UXP host for the exact proposed commit. Unit tests, browser previews and screenshots without an exercised workflow cannot substitute for host acceptance. Record unverified cases explicitly.
- GitHub requires `ls-studio-tests`, `ls-studio/computer-use`, an approving review and approval after the latest push. Do not mark the computer-use status successful without recorded evidence. Do not weaken protections to work around a blocked merge.
- Complete modules with explicit APIs and focused tests, integrate them in dependency order, then validate the assembled product. For LS Studio the contracts are in `apps/ls-studio/companion/domain/`; the implementation plan and file ownership are in `docs/v2/EXECUTION-PLAN.md`.
- Workers share the filesystem. Assign disjoint file ownership, do not revert other contributors, and coordinate shared entrypoints through the integrator. Host writes, real model requests and service changes must be serialized by the integrator.
- Use one coherent module or feature per PR. During the initial unmerged foundation, explicitly declared dependent PRs may use the preceding branch as their comparison base; do not merge them into an intermediate branch. After prerequisites merge, retarget to main, update against main, and renew review/checks/live evidence. An integration reference is not a substitute for module PR review.
- The root React PXD app and `apps/ls-studio/` are separate applications. Do not migrate one application's runtime assumptions into the other.
- Keep credentials, user PSDs/images, conversations, generated images and local runtime state out of Git. Use dedicated test material for host acceptance.
