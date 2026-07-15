import type { ColorizeWorkflowAdapters } from "./colorizeWorkflow";
import {
  deleteLayer,
  placeColorizedResult,
  prepareColorizeSource,
  restoreColorizeContext,
  validateColorizeSource
} from "./photoshop";

export const COLORIZE_PHOTOSHOP_ADAPTER: ColorizeWorkflowAdapters = {
  prepare: (taskId) => prepareColorizeSource({ taskId }),
  validate: (source, taskId) => validateColorizeSource(source, { taskId }),
  apply: (source, resultDataUrl, taskId, isCurrent) =>
    placeColorizedResult(source, resultDataUrl, isCurrent, { taskId }),
  rollback: async (source, layerId, taskId) => {
    let rollbackError: unknown;
    try {
      await restoreColorizeContext(source, { taskId });
    } catch (error) {
      rollbackError = error;
    }
    try {
      await deleteLayer(layerId, { taskId });
    } catch (error) {
      rollbackError = rollbackError
        ? new Error(
            `${rollbackError instanceof Error ? rollbackError.message : "上下文恢复失败"}；图层删除失败：${error instanceof Error ? error.message : "未知错误"}`
          )
        : error;
    }
    if (rollbackError) throw rollbackError;
  },
  restore: (source, taskId) => restoreColorizeContext(source, { taskId })
};
