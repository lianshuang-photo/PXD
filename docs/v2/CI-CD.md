# CI, build artifacts and release

PRs run the `LS Studio` workflow. The required `ls-studio-tests` aggregate only succeeds when module/integration tests and distributable validation succeed. The existing Alpha tag stays independent from this evolving source branch.

## PR checks and artifacts

- JavaScript syntax, manifest version agreement, referenced UI assets.
- Module/integration tests on Linux, macOS and Windows with Node 22, plus Linux Node 18 and 24. Hosted macOS skips the GUI launchd test explicitly; this does not count as real host acceptance.
- Deterministic ZIP packaging and an extracted-runtime smoke test with an ephemeral port and temporary state. Production services are not used.
- Downloadable combined application ZIP, UXP source ZIP, source checksum manifest, SPDX inventory and SHA256SUMS, retained as PR workflow artifacts for 30 days. Artifact name includes the PR head SHA.

Build locally with `npm --prefix apps/ls-studio run build`; outputs are ignored under `apps/ls-studio/dist/`. The manifest records the commit and dirty state. Release mode refuses a dirty checkout. Inputs are allowlisted; local state, secrets, user images and symlinks are rejected. Source paths, content hashes and fixed ZIP metadata make two builds of the same sources reproducible with the same Node/zlib runtime. The Node runtime is an external prerequisite, not bundled.

The UXP source ZIP is an unpacked-development distribution intended for UXP Developer Tool. It is not renamed to `.ccx` or claimed to be Adobe-signed. A signed CCX distribution requires the actual Adobe packaging/signing setup and a separately verified install/uninstall test before it is advertised as an installer. The combined ZIP includes the Companion and platform-neutral Node entrypoint; launchd scripts remain macOS-specific.

## Release gate

The manually dispatched `LS Studio release` workflow runs only against the current protected `main`. Its requested version must already match the app, Companion and UXP manifests. It checks successful main CI plus an associated merged PR with:

1. the same source tree as the proposed release;
2. an independent approving GitHub review of the final PR head and no remaining change request;
3. successful `ls-studio/computer-use` status on that head, linked to recorded evidence in the repository.

The `ls-studio-release` environment requires owner approval. The build then verifies the exact distributable, creates GitHub provenance attestations, creates an unused version tag and a **draft** GitHub release, and uploads the artifacts. It never overwrites an existing tag/release or publishes automatically. Check release notes/assets before publishing. A rerun after a partially created draft requires inspecting that draft and its assets first; it does not silently replace released bytes.

Missing review, missing host evidence or unavailable signing does not become a green release. Fixture tests and browser previews never set the live status. The baseline Alpha tag is already retained; no new production release is published by establishing these workflows.
