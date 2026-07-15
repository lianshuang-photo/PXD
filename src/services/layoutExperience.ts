import { bridge } from "./uxpBridge";

const LAYOUT_FILE = "layout-experience.json";
export const LAYOUT_STORE_VERSION = 1;
export const GUIDE_VERSION = 1;
export const MAX_LAYOUT_SNAPSHOTS = 20;

export const LAYOUT_SECTION_IDS = [
  "presets",
  "models",
  "generation",
  "controlnet",
  "prompts",
  "translation",
  "batch",
  "outputs"
] as const;

export type LayoutSectionId = (typeof LAYOUT_SECTION_IDS)[number];

export interface WorkspaceLayout {
  version: number;
  order: LayoutSectionId[];
  collapsed: LayoutSectionId[];
}

export interface LayoutSnapshot {
  id: string;
  name: string;
  createdAt: number;
  layout: WorkspaceLayout;
}

export interface GuideProgress {
  version: number;
  completed: boolean;
  stepIndex: number;
}

export interface LayoutExperienceStore {
  version: number;
  layout: WorkspaceLayout;
  snapshots: LayoutSnapshot[];
  undoLayout: WorkspaceLayout | null;
  guide: GuideProgress;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isSectionId = (value: unknown): value is LayoutSectionId =>
  typeof value === "string" && (LAYOUT_SECTION_IDS as readonly string[]).includes(value);

const createId = () => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
};

export const createDefaultLayout = (): WorkspaceLayout => ({
  version: LAYOUT_STORE_VERSION,
  order: [...LAYOUT_SECTION_IDS],
  collapsed: ["translation", "batch", "outputs"]
});

export const createDefaultLayoutStore = (): LayoutExperienceStore => ({
  version: LAYOUT_STORE_VERSION,
  layout: createDefaultLayout(),
  snapshots: [],
  undoLayout: null,
  guide: {
    version: GUIDE_VERSION,
    completed: false,
    stepIndex: 0
  }
});

export const normalizeWorkspaceLayout = (value: unknown): WorkspaceLayout => {
  const source = isRecord(value) ? value : {};
  const rawOrder = Array.isArray(source.order) ? source.order : [];
  const seen = new Set<LayoutSectionId>();
  const order: LayoutSectionId[] = [];
  for (const candidate of rawOrder) {
    if (!isSectionId(candidate) || seen.has(candidate)) continue;
    seen.add(candidate);
    order.push(candidate);
  }
  for (const sectionId of LAYOUT_SECTION_IDS) {
    if (!seen.has(sectionId)) order.push(sectionId);
  }

  const collapsed = Array.isArray(source.collapsed)
    ? source.collapsed.filter(isSectionId).filter((sectionId, index, all) => all.indexOf(sectionId) === index)
    : [];
  return {
    version: LAYOUT_STORE_VERSION,
    order,
    collapsed
  };
};

const normalizeGuide = (value: unknown): GuideProgress => {
  if (!isRecord(value) || value.version !== GUIDE_VERSION) {
    return createDefaultLayoutStore().guide;
  }
  return {
    version: GUIDE_VERSION,
    completed: value.completed === true,
    stepIndex: typeof value.stepIndex === "number" && Number.isFinite(value.stepIndex)
      ? Math.max(0, Math.floor(value.stepIndex))
      : 0
  };
};

const normalizeSnapshot = (value: unknown): LayoutSnapshot | null => {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || !value.id || value.id.length > 128) return null;
  const name = typeof value.name === "string" ? value.name.trim().slice(0, 48) : "";
  if (!name) return null;
  if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt) || value.createdAt <= 0) return null;
  return {
    id: value.id,
    name,
    createdAt: value.createdAt,
    layout: normalizeWorkspaceLayout(value.layout)
  };
};

export const normalizeLayoutStore = (value: unknown): LayoutExperienceStore => {
  if (!isRecord(value)) return createDefaultLayoutStore();
  const snapshots: LayoutSnapshot[] = [];
  const seen = new Set<string>();
  const seenNames = new Set<string>();
  if (Array.isArray(value.snapshots)) {
    for (const candidate of value.snapshots) {
      const snapshot = normalizeSnapshot(candidate);
      if (!snapshot || seen.has(snapshot.id) || seenNames.has(snapshot.name)) continue;
      seen.add(snapshot.id);
      seenNames.add(snapshot.name);
      snapshots.push(snapshot);
      if (snapshots.length === MAX_LAYOUT_SNAPSHOTS) break;
    }
  }
  return {
    version: LAYOUT_STORE_VERSION,
    layout: normalizeWorkspaceLayout(value.layout),
    snapshots,
    undoLayout: value.undoLayout == null ? null : normalizeWorkspaceLayout(value.undoLayout),
    guide: normalizeGuide(value.guide)
  };
};

export const loadLayoutStore = async (): Promise<LayoutExperienceStore> => {
  const stored = await bridge.readJsonFile<unknown>(LAYOUT_FILE, createDefaultLayoutStore());
  return normalizeLayoutStore(stored);
};

export const saveLayoutStore = async (store: LayoutExperienceStore): Promise<void> => {
  await bridge.writeJsonFile(LAYOUT_FILE, normalizeLayoutStore(store));
};

export const withLayout = (
  store: LayoutExperienceStore,
  layout: WorkspaceLayout,
  preserveUndo = false
): LayoutExperienceStore => ({
  ...store,
  layout: normalizeWorkspaceLayout(layout),
  undoLayout: preserveUndo ? store.undoLayout : null
});

export const withSavedSnapshot = (
  store: LayoutExperienceStore,
  rawName: string,
  now = Date.now()
): LayoutExperienceStore => {
  const name = rawName.trim().slice(0, 48);
  if (!name) throw new Error("请输入布局快照名称");
  const existing = store.snapshots.find((snapshot) => snapshot.name === name);
  const snapshot: LayoutSnapshot = {
    id: existing?.id ?? createId(),
    name,
    createdAt: now,
    layout: normalizeWorkspaceLayout(store.layout)
  };
  return {
    ...store,
    snapshots: [
      snapshot,
      ...store.snapshots.filter((candidate) => candidate.id !== snapshot.id && candidate.name !== name)
    ]
      .slice(0, MAX_LAYOUT_SNAPSHOTS)
  };
};

export const withAppliedSnapshot = (store: LayoutExperienceStore, snapshotId: string): LayoutExperienceStore => {
  const snapshot = store.snapshots.find((candidate) => candidate.id === snapshotId);
  if (!snapshot) throw new Error("未找到该布局快照");
  return {
    ...store,
    undoLayout: normalizeWorkspaceLayout(store.layout),
    layout: normalizeWorkspaceLayout(snapshot.layout)
  };
};

export const withUndoneLayout = (store: LayoutExperienceStore): LayoutExperienceStore => {
  if (!store.undoLayout) throw new Error("没有可撤销的布局切换");
  return {
    ...store,
    layout: normalizeWorkspaceLayout(store.undoLayout),
    undoLayout: null
  };
};

export const withResetLayout = (store: LayoutExperienceStore): LayoutExperienceStore => ({
  ...store,
  undoLayout: normalizeWorkspaceLayout(store.layout),
  layout: createDefaultLayout()
});

export const withDeletedSnapshot = (store: LayoutExperienceStore, snapshotId: string): LayoutExperienceStore => ({
  ...store,
  snapshots: store.snapshots.filter((snapshot) => snapshot.id !== snapshotId)
});

export const withGuideStep = (store: LayoutExperienceStore, stepIndex: number): LayoutExperienceStore => ({
  ...store,
  guide: {
    version: GUIDE_VERSION,
    completed: false,
    stepIndex: Math.max(0, Math.floor(stepIndex))
  }
});

export const withCompletedGuide = (store: LayoutExperienceStore): LayoutExperienceStore => ({
  ...store,
  guide: {
    version: GUIDE_VERSION,
    completed: true,
    stepIndex: 0
  }
});
