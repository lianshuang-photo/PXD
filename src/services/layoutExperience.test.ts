import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({
  readJsonFile: vi.fn(),
  writeJsonFile: vi.fn()
}));

vi.mock("./uxpBridge", () => ({ bridge: storage }));

import {
  GUIDE_VERSION,
  LAYOUT_SECTION_IDS,
  LAYOUT_STORE_VERSION,
  MAX_LAYOUT_SNAPSHOTS,
  createDefaultLayoutStore,
  loadLayoutStore,
  normalizeLayoutStore,
  saveLayoutStore,
  withAppliedSnapshot,
  withCompletedGuide,
  withResetLayout,
  withSavedSnapshot,
  withUndoneLayout
} from "./layoutExperience";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("layout experience persistence", () => {
  it("migrates changed section lists and resets stale guide versions", () => {
    const normalized = normalizeLayoutStore({
      version: 0,
      layout: {
        order: ["prompts", "removed-section", "prompts", "presets"],
        collapsed: ["removed-section", "models", "models"]
      },
      guide: { version: 0, completed: true, stepIndex: 99 }
    });

    expect(normalized.version).toBe(LAYOUT_STORE_VERSION);
    expect(normalized.layout.order.slice(0, 2)).toEqual(["prompts", "presets"]);
    expect(normalized.layout.order).toHaveLength(LAYOUT_SECTION_IDS.length);
    expect(new Set(normalized.layout.order)).toEqual(new Set(LAYOUT_SECTION_IDS));
    expect(normalized.layout.collapsed).toEqual(["models"]);
    expect(normalized.guide).toEqual({ version: GUIDE_VERSION, completed: false, stepIndex: 0 });
  });

  it("saves multiple named snapshots, replaces duplicate names, and enforces the cap", () => {
    let store = createDefaultLayoutStore();
    store = withSavedSnapshot(store, "修图", 1);
    store = withSavedSnapshot(store, "生成", 2);
    const originalId = store.snapshots.find((snapshot) => snapshot.name === "修图")?.id;
    store = withSavedSnapshot(store, "修图", 3);

    expect(store.snapshots).toHaveLength(2);
    expect(store.snapshots[0]).toMatchObject({ id: originalId, name: "修图", createdAt: 3 });

    for (let index = 0; index < MAX_LAYOUT_SNAPSHOTS + 4; index += 1) {
      store = withSavedSnapshot(store, `快照-${index}`, 10 + index);
    }
    expect(store.snapshots).toHaveLength(MAX_LAYOUT_SNAPSHOTS);
  });

  it("captures an undo layout before apply and supports reset plus one-step undo", () => {
    let store = createDefaultLayoutStore();
    store = {
      ...store,
      layout: { ...store.layout, order: [...store.layout.order].reverse(), collapsed: ["models"] }
    };
    store = withSavedSnapshot(store, "反向", 1);
    const snapshotId = store.snapshots[0].id;
    const beforeApply = { ...store.layout, order: [...store.layout.order], collapsed: [...store.layout.collapsed] };
    store = { ...store, layout: createDefaultLayoutStore().layout };

    const applied = withAppliedSnapshot(store, snapshotId);
    expect(applied.layout).toEqual(beforeApply);
    expect(applied.undoLayout).toEqual(createDefaultLayoutStore().layout);
    expect(withUndoneLayout(applied).layout).toEqual(createDefaultLayoutStore().layout);

    const reset = withResetLayout(applied);
    expect(reset.layout).toEqual(createDefaultLayoutStore().layout);
    expect(reset.undoLayout).toEqual(applied.layout);
  });

  it("loads and writes a normalized dedicated atomic JSON payload", async () => {
    storage.readJsonFile.mockResolvedValue({
      layout: { order: ["prompts"], collapsed: [] },
      snapshots: [],
      guide: { version: GUIDE_VERSION, completed: true, stepIndex: 2 }
    });
    const loaded = await loadLayoutStore();
    expect(storage.readJsonFile).toHaveBeenCalledWith(
      "layout-experience.json",
      expect.objectContaining({ version: LAYOUT_STORE_VERSION })
    );
    expect(loaded.layout.order[0]).toBe("prompts");

    await saveLayoutStore(loaded);
    expect(storage.writeJsonFile).toHaveBeenCalledWith(
      "layout-experience.json",
      expect.objectContaining({ version: LAYOUT_STORE_VERSION, layout: loaded.layout })
    );
  });

  it("preserves completed guide state so later launches do not force it again", () => {
    const completed = withCompletedGuide(createDefaultLayoutStore());
    expect(normalizeLayoutStore(completed).guide).toEqual({
      version: GUIDE_VERSION,
      completed: true,
      stepIndex: 0
    });
  });
});
