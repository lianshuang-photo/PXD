# Implementation status

Updated 2026-09-20. The user has approved implementation and explicitly requires preservation of Alpha, protected main, independent review and computer-use acceptance before merge.

| Package | Status | Evidence / remaining work |
|---|---|---|
| G00 | Implemented | 180 files imported with matching SHA256; separate CommonJS application; original 38 tests passed in the new directory; Alpha baseline tagged |
| G01 | Implemented | Shared validation, schemas, transitions, fixtures and module APIs; three domain boundary tests passed |
| G02 | Implemented and integrated | `bcf68a4`: immutable managed assets, revisioned drafts, durable jobs, deduplication and uncertain-outcome recovery; 24 module tests |
| G03 | Implemented; partial live acceptance | Capture, feather mask, combined name/opacity update, rollback and subsequent-edit conflict exercised on PS 26 / UXP 8; `b088846` fixes actual multi-property set behavior; placement still pending |
| G04 | Implemented and integrated; live provider pending | `4cbb207`: Gemini BYOK, capability limits, bounded image parsing, cancellation and redacted errors; 16 fixture tests; no configured key or real generation |
| G05 | Integrated and independently reviewed | Professional workspace consumes shared drafts, source capture, jobs and results; native Chrome UI exercised the real UXP bridge; floating plugin panel visual/input acceptance remains pending |
| G06 | Implemented and reviewed | `fa789db`: 17 Studio tools plus 7 existing Photoshop tools, shared HTTP/MCP handlers and image blocks; 21 transport/bridge tests |
| G07 | Implemented and reviewed | `fa789db`: 121 recipes, 101 numeric parameters, immutable source hashes, explicit reference mapping and two project Skills; 14 catalog/service tests |
| G08 | Not passed | [Partial live evidence](evidence/2026-09-20-host-partial.md) records exact tested commit, actual host results and outstanding provider/panel/sample cases |
| G09–G21 | Planned | Later product phases remain in the approved scope |

The final local regression at `f0cd2e5619a8819195377bc0a7a8cb32d85ae3af` passed **193/193** tests, including isolated launchd lifecycle coverage and 11 release-gate regressions. Syntax/manifests checked 67 JavaScript files. The packaged 0.1.6 application passed extracted startup, file-hash and UXP ZIP checks. This is the suite count, not a sum of the evidence column. The first hosted matrix/build run [passed on 469a608](https://github.com/lianshuang-photo/PXD/actions/runs/35464311154); the latest head must also pass the checks attached to [PR #51](https://github.com/lianshuang-photo/PXD/pull/51).

The production capability surface currently supports `image.edit` and `ps.layer.update` (name, opacity and visibility). Capture and placement are limited to 8 million pixels / 32 MiB, with RGB 8/16-bit capture adapted to sRGB8. PNG/JPEG return creates a new raster layer; grouping, WebP return and 32-bit HDR are explicitly unsupported. A large original needs a supported selection. Requesting 4K with automatic placement fails before a provider request; manual generation may retain the output, and actual unsupported output stays a managed asset without host dispatch.

CI/CD covers supported Node versions on Linux/macOS/Windows, reproducible runtime/source ZIPs, extracted startup, checksum manifests, SPDX inventory and provenance-backed draft releases. The release workflow requires protected main, final-head review and an immutable, complete real-host evidence record. It revalidates after owner environment approval and again before creating the tag. See [CI/CD](CI-CD.md). The release workflow itself has not been dispatched or claimed as a completed publication.

No main merge, production service replacement or real model request has occurred in this implementation stage. [Collaboration rules](COLLABORATION.md) define the merge gate. G00–G07 implementation does not mean M0/M1 or the complete COS-to-publication workflow has passed.
