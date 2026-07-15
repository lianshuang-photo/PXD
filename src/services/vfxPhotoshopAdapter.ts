import {
  captureVfxSource,
  placeVfxResult,
  restoreVfxContext,
  rollbackVfxResult,
  validateVfxSource
} from "./photoshop";
import type { VfxWorkflowAdapters } from "./vfxWorkflow";

export const VFX_PHOTOSHOP_ADAPTER: VfxWorkflowAdapters = {
  capture: (taskId) => captureVfxSource({ taskId }),
  validate: (source, taskId) => validateVfxSource(source, { taskId }),
  apply: (source, dataUrl, config, taskId, isCurrent) =>
    placeVfxResult(
      source,
      dataUrl,
      { blendMode: config.blendMode, useSelectionMask: config.useSelectionMask },
      isCurrent,
      { taskId }
    ),
  rollback: (source, layerId, taskId) => rollbackVfxResult(source, layerId, { taskId }),
  restore: (source, taskId) => restoreVfxContext(source, { taskId })
};
