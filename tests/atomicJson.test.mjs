import assert from "node:assert/strict";
import test from "node:test";
import {
  jsonBackupFileName,
  readAtomicJson,
  writeAtomicJson
} from "../.test-dist/atomicJson.js";

const createMemoryStorage = (initial = {}) => {
  const files = new Map(Object.entries(initial));
  const writes = [];
  const storage = {
    async readText(fileName) {
      return files.get(fileName) ?? null;
    },
    async writeText(fileName, content) {
      writes.push(fileName);
      files.set(fileName, content);
    }
  };
  return { files, storage, writes };
};

test("writes a complete backup before replacing the primary JSON file", async () => {
  const { files, storage, writes } = createMemoryStorage();
  const payload = { endpoint: "http://localhost:7860", offline: true };

  await writeAtomicJson(storage, "settings.json", payload);

  assert.deepEqual(writes, ["settings.json.bak", "settings.json"]);
  assert.deepEqual(JSON.parse(files.get("settings.json.bak")), payload);
  assert.deepEqual(JSON.parse(files.get("settings.json")), payload);
});

test("recovers and repairs the primary file when its write is interrupted", async () => {
  const { files, storage } = createMemoryStorage({
    "settings.json": JSON.stringify({ endpoint: "old" })
  });
  const interruptedStorage = {
    readText: storage.readText,
    async writeText(fileName, content) {
      if (fileName === "settings.json") {
        files.set(fileName, content.slice(0, 3));
        throw new Error("simulated interruption");
      }
      await storage.writeText(fileName, content);
    }
  };
  const payload = { endpoint: "new", offline: false };

  await assert.rejects(writeAtomicJson(interruptedStorage, "settings.json", payload));
  assert.deepEqual(JSON.parse(files.get(jsonBackupFileName("settings.json"))), payload);

  const recovered = await readAtomicJson(storage, "settings.json", { endpoint: "default" });
  assert.deepEqual(recovered, payload);
  assert.deepEqual(JSON.parse(files.get("settings.json")), payload);
});

test("uses the supplied fallback only when both primary and backup are invalid", async () => {
  const { storage } = createMemoryStorage({
    "settings.json": "{",
    "settings.json.bak": "also invalid"
  });
  const fallback = { endpoint: "default" };

  assert.equal(await readAtomicJson(storage, "settings.json", fallback), fallback);
});

test("does not replace a valid primary file with an older backup", async () => {
  const current = { version: 2 };
  const { storage } = createMemoryStorage({
    "preset.json": JSON.stringify(current),
    "preset.json.bak": JSON.stringify({ version: 1 })
  });

  assert.deepEqual(await readAtomicJson(storage, "preset.json", { version: 0 }), current);
});
