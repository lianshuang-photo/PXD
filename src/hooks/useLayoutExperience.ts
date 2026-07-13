import { useCallback, useEffect, useRef, useState } from "react";
import {
  createDefaultLayoutStore,
  loadLayoutStore,
  normalizeWorkspaceLayout,
  saveLayoutStore,
  withAppliedSnapshot,
  withCompletedGuide,
  withDeletedSnapshot,
  withGuideStep,
  withLayout,
  withResetLayout,
  withSavedSnapshot,
  withUndoneLayout,
  type LayoutExperienceStore,
  type LayoutSectionId,
  type WorkspaceLayout
} from "../services/layoutExperience";

type StoreTransform = (current: LayoutExperienceStore) => LayoutExperienceStore;

export const useLayoutExperience = () => {
  const [store, setStore] = useState(createDefaultLayoutStore);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const storeRef = useRef(store);
  const loadPromiseRef = useRef<Promise<LayoutExperienceStore> | null>(null);
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingWritesRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    storeRef.current = store;
  }, [store]);

  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  const load = useCallback(async () => {
    if (!loadPromiseRef.current) {
      loadPromiseRef.current = loadLayoutStore()
        .then((loaded) => {
          storeRef.current = loaded;
          if (mountedRef.current) {
            setStore(loaded);
            setError(null);
          }
          return loaded;
        })
        .catch((caught) => {
          const message = caught instanceof Error ? caught.message : "布局数据加载失败";
          if (mountedRef.current) setError(message);
          return storeRef.current;
        })
        .finally(() => {
          if (mountedRef.current) setLoading(false);
        });
    }
    return await loadPromiseRef.current;
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const commit = useCallback(async (transform: StoreTransform) => {
    await load();
    pendingWritesRef.current += 1;
    if (mountedRef.current) setSaving(true);
    let committed: LayoutExperienceStore | null = null;
    const write = writeQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        const next = transform(storeRef.current);
        await saveLayoutStore(next);
        storeRef.current = next;
        committed = next;
        if (mountedRef.current) {
          setStore(next);
          setError(null);
        }
      });
    writeQueueRef.current = write;
    try {
      await write;
      return committed as LayoutExperienceStore;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "布局数据保存失败";
      if (mountedRef.current) setError(message);
      throw caught;
    } finally {
      pendingWritesRef.current -= 1;
      if (mountedRef.current && pendingWritesRef.current === 0) setSaving(false);
    }
  }, [load]);

  const updateLayout = useCallback(
    (layout: WorkspaceLayout) => commit((current) => withLayout(current, layout)),
    [commit]
  );

  const setSectionCollapsed = useCallback((sectionId: LayoutSectionId, collapsed: boolean) => {
    return commit((current) => {
      const layout = current.layout;
      const nextCollapsed = collapsed
        ? [...layout.collapsed.filter((candidate) => candidate !== sectionId), sectionId]
        : layout.collapsed.filter((candidate) => candidate !== sectionId);
      return withLayout(current, { ...layout, collapsed: nextCollapsed });
    });
  }, [commit]);

  const moveSection = useCallback((sectionId: LayoutSectionId, direction: -1 | 1) => {
    return commit((current) => {
      const order = [...current.layout.order];
      const from = order.indexOf(sectionId);
      const to = from + direction;
      if (from < 0 || to < 0 || to >= order.length) return current;
      [order[from], order[to]] = [order[to], order[from]];
      return withLayout(current, normalizeWorkspaceLayout({ ...current.layout, order }));
    });
  }, [commit]);

  return {
    store,
    loading,
    saving,
    error,
    reload: load,
    updateLayout,
    setSectionCollapsed,
    moveSection,
    saveSnapshot: (name: string) => commit((current) => withSavedSnapshot(current, name)),
    applySnapshot: (id: string) => commit((current) => withAppliedSnapshot(current, id)),
    undoLayout: () => commit(withUndoneLayout),
    resetLayout: () => commit(withResetLayout),
    deleteSnapshot: (id: string) => commit((current) => withDeletedSnapshot(current, id)),
    setGuideStep: (stepIndex: number) => commit((current) => withGuideStep(current, stepIndex)),
    completeGuide: () => commit(withCompletedGuide),
    restartGuide: () => commit((current) => withGuideStep(current, 0))
  };
};
