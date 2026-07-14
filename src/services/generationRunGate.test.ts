import { describe, expect, it } from "vitest";
import { GenerationRunGate } from "./generationRunGate";

describe("GenerationRunGate", () => {
  it("invalidates a stopped run so late completion cannot affect the next run", () => {
    const gate = new GenerationRunGate();
    const stopped = gate.begin("single", "first");

    expect(gate.stop()).toEqual(stopped);
    expect(gate.isCurrent(stopped.token)).toBe(false);
    expect(gate.complete(stopped.token)).toBe(false);

    const next = gate.begin("single", "second");
    expect(next.token).toBeGreaterThan(stopped.token);
    expect(gate.current).toEqual(next);
  });

  it("tracks the active batch task without changing the run token", () => {
    const gate = new GenerationRunGate();
    const run = gate.begin("batch");

    expect(gate.setTask(run.token, "batch-item-1")).toBe(true);
    expect(gate.current).toMatchObject({ token: run.token, kind: "batch", taskId: "batch-item-1" });
    expect(gate.complete(run.token)).toBe(true);
    expect(gate.current).toBeNull();
  });
});
