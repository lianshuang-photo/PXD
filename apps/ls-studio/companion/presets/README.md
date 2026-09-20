# Shared user presets (B05)

`createRecipeLibrary({rootDir, factoryCatalog})` combines the bundled read-only catalog with a separate user library. The server supplies `PXDLS_DATA_DIR/presets` (by default `~/.pxdls/studio/presets`). No operation changes `factory_presets`, an existing draft, a job snapshot or Photoshop. Loading a definition into a draft remains a separate `loadRecipe` operation; running the draft remains a separate `run`.

The library provides `list`, `get(recipeId, revision?)`, `compile`, `create`, `copy`, `update`, `import`, `export`, `versions`, `archive` and `restore`. All returned values are independent copies. A user recipe has `kind: "user"`, an opaque `user-*` ID, a monotonic `revision`, a definition `sourceHash`, an archive flag and its source (`ui`/`agent`/`system`). Copying retains the source recipe ID/hash. A factory recipe has `kind: "factory"` and revision 1; copying creates an independent user identity.

## Definition and portable files

A definition contains `title`, `category`, optional `subCategory`, `content` (a JSON object encoded as a string), and optional `refImages` (reference slots). It uses the same compiler as factory recipes, including nested numeric `@param:name` values in 0–1, descriptions, exact defaults and the 32-parameter limit. Titles/categories cannot be blank. Each reference slot is `{slotId,label,role}` where role is `reference`, `identity`, `style` or `structure`; up to 16 unique slots are supported.

Exports are `{schemaVersion:1,format:"ls-studio-preset",definition}`. They contain the definition and reference slots, not images, local asset IDs, document captures, histories or credentials. After import, the user/Agent explicitly maps each slot to a managed image with its declared role. Arbitrary paths, image URLs, binary attachments, unknown import fields and unsupported formats are rejected. Import assigns a new local ID; it cannot overwrite a factory or another user preset. The panel accepts UTF-8 JSON files up to 512 KiB; definitions are limited to 256 KiB and the existing HTTP request bound is 512 KiB. Browser download and UXP file picker/save are adapters over the same JSON contract.

## Revisions and errors

- `create({definition,requestId,source})`, `copy({recipeId,revision?,expectedSourceHash,title?,requestId,source})` and `import({bundle,requestId,source})` durably deduplicate the request ID. Reusing it with different content fails with `REQUEST_CONFLICT`. A retry returns the current preset for that identity.
- `update({recipeId,expectedRevision,definition,source})` replaces a complete definition. A stale revision returns `RECIPE_REVISION_CONFLICT` with `details.current`; the caller's unsaved form remains available.
- `archive({recipeId,expectedRevision,source})` appends an archived version and hides the preset from normal lists. Nothing is deleted.
- `restore({recipeId,expectedRevision,targetRevision?,source})` appends a new active version from the chosen history entry (or current definition when unarchiving). Earlier records are never rewritten.
- `versions({recipeId})` returns newest-first revision metadata; `get` can read any recorded revision. `export({recipeId,revision?})` exports that definition only.
- `compile`/`loadRecipe` requires `expectedSourceHash` for a user preset and rejects archived or changed definitions. Explicit reference mapping is mandatory whenever slots exist. Factory callers remain compatible. A job already owns its compiled prompt/hash/values and never changes when the library changes.

The HTTP adapter stamps the actual UI/Agent source on every mutation. MCP exposes eight new operations: `studio_create_recipe`, `studio_copy_recipe`, `studio_update_recipe`, `studio_import_recipe`, `studio_export_recipe`, `studio_archive_recipe`, `studio_restore_recipe` and `studio_list_recipe_versions`. Existing recipe list/get/load tools share the same library. Raw store paths are not public arguments.

## Persistence and verification

One Companion process owns this library. A versioned, checksummed `presets.json` transaction contains immutable revisions and creation/import request deduplication. Writes flush a new temporary file, atomically rename it, then flush the directory on POSIX. Windows flushes files but does not claim POSIX directory-fsync power-loss guarantees. The initialization marker prevents a missing store from silently resetting. Corruption, incompatible data and symlinked state fail closed; crash temporary files are not promoted. Limits are 1000 user presets, 500 revisions per preset and 32 MiB total; there is no destructive pruning or automatic garbage collection.

Run from the repository root:

```sh
node --test apps/ls-studio/tests/presets-store.test.cjs apps/ls-studio/tests/presets-integration.test.cjs apps/ls-studio/tests/presets-ui.test.cjs
```

Fixtures cover restart, conflicts, immutable history, archive/restore, import/export, atomic publication failure, corrupt/missing state, duplicate submission, shared HTTP/MCP source attribution, explicit reference mappings and preservation of existing job snapshots. Mounted controls and injected UXP storage APIs are tested. Actual UXP layout, native JSON picker/save, and UI-to-Agent conversation handoff still require separate live acceptance; these tests never contact a paid provider or real Photoshop.
