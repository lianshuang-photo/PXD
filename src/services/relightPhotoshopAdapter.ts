import type { RelightWorkflowAdapters } from "./relightWorkflow";
import {
  captureRelightSource,
  placeRelitResult,
  rollbackRelitResult,
  restoreRelightContext,
  validateRelightSource
} from "./photoshop";
import { prepareRelightEnergyLayer } from "./relightEnergyLayer";

export const RELIGHT_PHOTOSHOP_ADAPTER: RelightWorkflowAdapters = {
  capture: (taskId) => captureRelightSource({ taskId }),
  validate: (source, taskId) => validateRelightSource(source, { taskId }),
  prepare: prepareRelightEnergyLayer,
  apply: (source, dataUrl, opacity, taskId, isCurrent) =>
    placeRelitResult(source, dataUrl, opacity, isCurrent, { taskId }),
  rollback: (source, layerId, taskId) => rollbackRelitResult(source, layerId, { taskId }),
  restore: (source, taskId) => restoreRelightContext(source, { taskId })
};
