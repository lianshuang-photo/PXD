# LS Studio / PXD V2

This directory imports LS Alpha 0.1.5 into PXD. Product planning and current acceptance criteria live in [docs/v2](../../docs/v2/README.md). The repository root remains the original React/TypeScript PXD application; this package explicitly uses CommonJS for the existing UXP and Companion code.

Use Node.js 18 or newer. No package installation is required for the Companion:

```sh
npm --prefix apps/ls-studio test
npm --prefix apps/ls-studio run prepare:dev
npm --prefix apps/ls-studio run dev
```

The development launcher uses port 17881 and this application's ignored `.local/` directory, separate from the installed Alpha service and conversations. Open `http://127.0.0.1:17881/ui/` for the browser preview. It does not install or restart the production launchd service. Load `.local/uxp/manifest.json` in UXP Developer Tool for the distinct `LS Studio V2 Dev` panel. Regenerate that copy after source changes.

`npm start` retains the original environment-controlled entrypoint. Existing service installation scripts are imported for traceability; running them intentionally replaces the configured installed runtime, so development should use `npm run dev`.

The import preserves the Alpha's behavior, including mock generation. New production capabilities and their verification status are documented as they are integrated; browser preview alone does not verify Photoshop writes or real image generation.

See [source provenance](SOURCE-PROVENANCE.md) for the imported baseline and limitations.

This foundation branch contains the preserved import, shared contracts and delivery tooling. Production modules arrive through separate dependent PRs; see [modular delivery](../../docs/v2/MODULAR-DELIVERY.md). Build ZIPs with `npm --prefix apps/ls-studio run build`. The [CI/CD policy](../../docs/v2/CI-CD.md) requires independent review and actual host evidence before a release; CI success alone does not establish product acceptance.
