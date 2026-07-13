import { beforeEach, expect, test, vi } from "vitest";

vi.mock("../src/services/uxpBridge", () => ({
  bridge: {
    photoshop: {
      app: {
        activeDocument: { id: 7 },
        batchPlay: vi.fn()
      },
      core: {
        executeAsModal: vi.fn(async (operation: () => Promise<unknown>) => await operation())
      }
    },
    uxp: {
      storage: {
        formats: { binary: "binary" },
        localFileSystem: {
          getTemporaryFolder: vi.fn(async () => ({
            createFile: vi.fn(async () => ({ write: vi.fn(async () => undefined) }))
          })),
          createSessionToken: vi.fn(async () => "session-token")
        }
      }
    }
  }
}));

import { bridge } from "../src/services/uxpBridge";
import { moveActiveLayerToTop, placeImageIntoDocument } from "../src/services/photoshop";
import {
  clearPSLockQueue,
  PSCircuitOpenError,
  PSLockCancelledError,
  PSOperationTimeoutError
} from "../src/services/psLock";

const photoshop = bridge.photoshop as any;
const batchPlay = photoshop.app.batchPlay as ReturnType<typeof vi.fn>;
const executeAsModal = photoshop.core.executeAsModal as ReturnType<typeof vi.fn>;

beforeEach(() => {
  batchPlay.mockReset();
  executeAsModal.mockClear();
});

test("a multi-modal image placement remains one exclusive transaction", async () => {
  const events: string[] = [];
  let releaseFirstPlace: (() => void) | undefined;
  let firstPlace = true;
  batchPlay.mockImplementation(async (descriptors: Array<{ _obj: string }>) => {
    const operation = descriptors[0]?._obj;
    events.push(operation);
    if (operation === "placeEvent" && firstPlace) {
      firstPlace = false;
      await new Promise<void>((resolve) => {
        releaseFirstPlace = resolve;
      });
    }
    return operation === "get" ? [{ layerID: events.length }] : [];
  });

  const first = placeImageIntoDocument("data:image/png;base64,ZmFrZQ==", 1, undefined, {
    taskId: "first"
  });
  await vi.waitFor(() => expect(events).toEqual(["placeEvent"]));

  const second = placeImageIntoDocument("data:image/png;base64,ZmFrZQ==", 2, undefined, {
    taskId: "second"
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(events).toEqual(["placeEvent"]);

  releaseFirstPlace?.();
  await Promise.all([first, second]);
  expect(events).toEqual(["placeEvent", "get", "placeEvent", "get"]);
});

test("taskId cancellation reaches queued Photoshop operations", async () => {
  let releaseActive: (() => void) | undefined;
  batchPlay.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      releaseActive = resolve;
    });
    return [];
  });

  const active = moveActiveLayerToTop({ taskId: "active", layerId: 11 });
  await vi.waitFor(() => expect(executeAsModal).toHaveBeenCalledTimes(1));
  const cancelled = moveActiveLayerToTop({ taskId: "cancelled", layerId: 12 });

  expect(clearPSLockQueue("cancelled")).toBe(1);
  await expect(cancelled).rejects.toBeInstanceOf(PSLockCancelledError);
  expect(executeAsModal).toHaveBeenCalledTimes(1);

  releaseActive?.();
  await active;
});

test("a Photoshop timeout opens the circuit without releasing the unfinished modal", async () => {
  let releaseTimedOutModal: (() => void) | undefined;
  batchPlay.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      releaseTimedOutModal = resolve;
    });
    return [];
  });

  const timedOut = moveActiveLayerToTop({ taskId: "timed-out", layerId: 21, timeoutMs: 20 });
  await vi.waitFor(() => expect(executeAsModal).toHaveBeenCalledTimes(1));
  const following = moveActiveLayerToTop({ taskId: "following", layerId: 22, timeoutMs: 1_000 });
  const followingAssertion = expect(following).rejects.toBeInstanceOf(PSCircuitOpenError);

  await expect(timedOut).rejects.toBeInstanceOf(PSOperationTimeoutError);
  await followingAssertion;
  await expect(
    moveActiveLayerToTop({ taskId: "during-circuit", layerId: 23, timeoutMs: 1_000 })
  ).rejects.toBeInstanceOf(PSCircuitOpenError);
  expect(executeAsModal).toHaveBeenCalledTimes(1);

  releaseTimedOutModal?.();
  await new Promise((resolve) => setTimeout(resolve, 200));
  await moveActiveLayerToTop({ taskId: "recovered", layerId: 24, timeoutMs: 1_000 });
  expect(executeAsModal).toHaveBeenCalledTimes(2);
});

test("moveActiveLayerToTop targets the supplied layer ID", async () => {
  batchPlay.mockResolvedValue([]);

  await moveActiveLayerToTop({ taskId: "move", layerId: 42 });

  const descriptors = batchPlay.mock.calls[0][0];
  expect(descriptors[0]._target).toEqual([{ _ref: "layer", _id: 42 }]);
});
