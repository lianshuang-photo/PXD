import type { RelightWorkflowAdapters } from "./relightWorkflow";
import {
  captureRelightSource,
  placeRelitResult,
  rollbackRelitResult,
  restoreRelightContext,
  validateRelightSource
} from "./photoshop";

export const RELIGHT_PHOTOSHOP_ADAPTER: RelightWorkflowAdapters = {
  capture: (taskId) => captureRelightSource({ taskId }),
  validate: (source, taskId) => validateRelightSource(source, { taskId }),
  apply: (source, dataUrl, taskId, isCurrent) =>
    placeRelitResult(source, dataUrl, isCurrent, { taskId }),
  rollback: (source, layerId, taskId) => rollbackRelitResult(source, layerId, { taskId }),
  restore: (source, taskId) => restoreRelightContext(source, { taskId })
};
