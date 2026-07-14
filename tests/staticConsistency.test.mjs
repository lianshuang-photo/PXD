import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const srcRoot = fileURLToPath(new URL("../src/", import.meta.url));

const collectSourceFiles = (directory) => {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectSourceFiles(path));
    else if ([".css", ".ts", ".tsx"].includes(extname(entry.name))) files.push(path);
  }
  return files;
};

test("every referenced CSS custom property is defined", () => {
  const css = readFileSync(new URL("../src/styles/global.css", import.meta.url), "utf8");
  const definitions = new Set([...css.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map((match) => match[1]));
  const references = new Set();
  for (const file of collectSourceFiles(srcRoot)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)) references.add(match[1]);
  }

  assert.deepEqual([...references].filter((name) => !definitions.has(name)).sort(), []);
});

test("package and plugin manifest versions stay aligned", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));

  assert.equal(packageJson.version, manifest.version);
});

test("removed settings are not exposed by current types or settings UI", () => {
  const contextTypes = readFileSync(new URL("../src/context/types.ts", import.meta.url), "utf8");
  const settingsPanel = readFileSync(new URL("../src/panels/SettingsPanel.tsx", import.meta.url), "utf8");
  const generationController = readFileSync(new URL("../src/hooks/useGenerationController.ts", import.meta.url), "utf8");

  assert.doesNotMatch(contextTypes, /\boutputDirectory\b/);
  assert.doesNotMatch(settingsPanel, /\boutputDirectory\b|输出目录/);
  assert.doesNotMatch(generationController, /\bsetPresetShortcut\b/);
});
