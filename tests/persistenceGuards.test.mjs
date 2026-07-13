import assert from "node:assert/strict";
import test from "node:test";
import { LatestLoadGate } from "../.test-dist/loadGate.js";
import { deletePresetEntries } from "../.test-dist/presetDeletion.js";

const notFoundError = (fileName) => {
  const error = new Error(`${fileName} not found`);
  error.name = "NotFoundError";
  return error;
};

const createFolder = (fileNames, failureByFile = new Map()) => {
  const files = new Set(fileNames);
  const deletions = [];
  return {
    files,
    deletions,
    folder: {
      async getEntry(fileName) {
        if (!files.has(fileName)) {
          throw notFoundError(fileName);
        }
        return {
          async delete() {
            deletions.push(fileName);
            const failure = failureByFile.get(fileName);
            if (failure) {
              throw failure;
            }
            files.delete(fileName);
          }
        };
      }
    }
  };
};

test("preset deletion removes the backup before the primary", async () => {
  const { files, deletions, folder } = createFolder(["portrait.json", "portrait.json.bak"]);

  await deletePresetEntries(folder, "portrait.json");

  assert.deepEqual(deletions, ["portrait.json.bak", "portrait.json"]);
  assert.equal(files.size, 0);
});

test("an interrupted primary deletion cannot leave a backup that resurrects the preset", async () => {
  const interrupted = new Error("simulated delete interruption");
  const { files, folder } = createFolder(
    ["portrait.json", "portrait.json.bak"],
    new Map([["portrait.json", interrupted]])
  );

  await assert.rejects(deletePresetEntries(folder, "portrait.json"), interrupted);
  assert.equal(files.has("portrait.json.bak"), false);
  assert.equal(files.has("portrait.json"), true);
});

test("preset deletion only ignores an explicit missing-entry error", async () => {
  const denied = new Error("permission denied");
  const folder = {
    async getEntry() {
      throw denied;
    }
  };

  await assert.rejects(deletePresetEntries(folder, "portrait.json"), denied);
});

test("preset deletion tolerates an entry removed between lookup and delete", async () => {
  const folder = {
    async getEntry() {
      return {
        async delete() {
          throw notFoundError("concurrently removed entry");
        }
      };
    }
  };

  await assert.doesNotReject(deletePresetEntries(folder, "portrait.json"));
});

test("persistence is rejected until the current load completes", () => {
  const gate = new LatestLoadGate();
  const generation = gate.begin();

  assert.throws(() => gate.assertReady("still loading"), /still loading/);
  assert.equal(gate.complete(generation), true);
  assert.doesNotThrow(() => gate.assertReady("still loading"));
});

test("an older overlapping load cannot commit state or reopen the gate", () => {
  const gate = new LatestLoadGate();
  const first = gate.begin();
  const second = gate.begin();
  let state = "initial";

  if (gate.isCurrent(first)) state = "stale";
  assert.equal(gate.complete(first), false);
  assert.throws(() => gate.assertReady("still loading"), /still loading/);

  if (gate.isCurrent(second)) state = "latest";
  assert.equal(gate.complete(second), true);
  assert.equal(state, "latest");
  assert.doesNotThrow(() => gate.assertReady("still loading"));
});

test("a late older load cannot overwrite the latest state or close its open gate", () => {
  const gate = new LatestLoadGate();
  const first = gate.begin();
  const second = gate.begin();
  let state = "initial";

  if (gate.isCurrent(second)) state = "latest";
  assert.equal(gate.complete(second), true);

  if (gate.isCurrent(first)) state = "stale";
  assert.equal(gate.complete(first), false);
  assert.equal(state, "latest");
  assert.doesNotThrow(() => gate.assertReady("still loading"));
});
