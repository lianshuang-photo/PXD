# Implementation status

Updated 2026-09-20. The user has approved implementation and explicitly requires preservation of Alpha, protected main, independent review and computer-use acceptance before merge.

| Package | Status | Evidence / remaining work |
|---|---|---|
| G00 | Implemented | 180 files imported with matching SHA256; separate CommonJS application; original 38 tests passed in the new directory; Alpha baseline tagged |
| G01 | Implemented | Shared validation, schemas, transitions, fixtures and module APIs; three domain boundary tests passed |
| G02 | Implemented and integrated | `bcf68a4`: immutable managed assets, revisioned drafts, durable jobs, deduplication and uncertain-outcome recovery; 24 module tests |
| G03 | Implemented; live acceptance pending | `6e3bb82`: actual selection-mask capture, bounded native layer-property writes, new-layer placement and guarded receipts/rollback; 23 production-host fixture tests |
| G04 | Implemented and integrated; live provider pending | `4cbb207`: Gemini BYOK, capability limits, bounded image parsing, cancellation and redacted errors; 16 fixture tests; no configured key or real generation |
| G05 | Integrated; independent review in progress | Professional workspace consumes shared drafts, source capture, jobs and results; source of truth is Companion; real UXP exercise still pending |
| G06 | Implemented and reviewed | `fa789db`: 17 Studio tools plus 7 existing Photoshop tools, shared HTTP/MCP handlers and image blocks; 21 transport/bridge tests |
| G07 | Implemented and reviewed | `fa789db`: 121 recipes, 101 numeric parameters, immutable source hashes, explicit reference mapping and two project Skills; 14 catalog/service tests |
| G08 | Not passed | Real Photoshop/UXP and provider/sample acceptance required; no new live evidence yet |
| G09–G21 | Planned | Later product phases remain in the approved scope |

The first assembled local regression passed 158 tests, including isolated launchd lifecycle coverage. This total includes overlapping module boundaries and is the suite count, not a sum of the evidence column. UI review and hosted cross-platform CI remain separate checks.

The production capability surface currently supports `image.edit` and `ps.layer.update` (name, opacity and visibility). Capture is limited to 8 million pixels and RGB 8/16-bit sources adapted to sRGB8. PNG/JPEG return creates a new raster layer; grouping, WebP return and 32-bit HDR are explicitly unsupported. A large original needs a supported selection; silently downscaling the full document is not used as a workaround.

CI/CD covers supported Node versions on Linux/macOS/Windows, reproducible runtime/source ZIPs, extracted startup, checksum manifests, SPDX inventory and provenance-backed draft releases. The release workflow requires protected main, final-head review and real-host evidence before the owner-reviewed environment can create a draft. See [CI/CD](CI-CD.md).

No main merge, production service replacement or real model request has occurred in this implementation stage. [Collaboration rules](COLLABORATION.md) define the merge gate. G00–G07 implementation does not mean M0/M1 or the complete COS-to-publication workflow has passed.
