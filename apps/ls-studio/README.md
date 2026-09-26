# LS Studio / PXD V2

This directory develops LS Studio 0.1.6 from the preserved Alpha 0.1.5 baseline (`ls-studio-v2-alpha.0`). Product planning and current acceptance criteria live in [docs/v2](../../docs/v2/README.md). The repository root remains the original React/TypeScript PXD application; this package explicitly uses CommonJS for UXP and Companion code.

Use Node.js 18 or newer. No package installation is required for the Companion:

```sh
npm --prefix apps/ls-studio test
npm --prefix apps/ls-studio run prepare:dev
npm --prefix apps/ls-studio run dev
```

The development launcher uses port 17881 and this application's ignored `.local/` directory, separate from the installed Alpha service and conversations. Open `http://127.0.0.1:17881/ui/` for the browser preview. For Photoshop tests, load the generated `.local/uxp/manifest.json` in UXP Developer Tool: its distinct plugin ID and panel name allow the Alpha to stay loaded. Regenerate it after source changes. It does not install or restart the production launchd service.

`npm start` retains the original environment-controlled entrypoint. Existing service installation scripts are imported for traceability; running them intentionally replaces the configured installed runtime, so development should use `npm run dev`.

The production workspace shares drafts/jobs with Agent tools, uses managed assets and bounded Photoshop mutations, and has a BYOK Gemini adapter. Read [provider setup](companion/providers/README.md) and the current implementation status before testing. Unsupported or unconfigured paths report their limits; browser preview alone does not verify Photoshop writes or real image generation. Old mock HTTP routes remain explicit compatibility interfaces, outside the new professional execution path.

Build distributables with `npm --prefix apps/ls-studio run build`. [CI/CD](../../docs/v2/CI-CD.md) describes automated checks, build artifacts, and the independent review plus real-host release gate. New runtime files must be staged/committed to enter the tracked-file package; local ignored state never ships.

See [source provenance](SOURCE-PROVENANCE.md) for the imported baseline and limitations.

The first integration reference (#51) has been replaced by separate module PRs. See [modular delivery](../../docs/v2/MODULAR-DELIVERY.md) for dependencies and the rule to retarget dependent PRs to main after their prerequisites merge.
