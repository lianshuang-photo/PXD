export type GenerationRunKind = "single" | "batch" | "relight";

export interface GenerationRun {
  token: number;
  kind: GenerationRunKind;
  taskId?: string;
}

export class GenerationRunGate {
  private sequence = 0;
  private activeRun: GenerationRun | null = null;

  get current() {
    return this.activeRun;
  }

  begin(kind: GenerationRunKind, taskId?: string) {
    const run = { token: ++this.sequence, kind, taskId };
    this.activeRun = run;
    return run;
  }

  isCurrent(token: number) {
    return this.activeRun?.token === token;
  }

  setTask(token: number, taskId: string) {
    if (!this.isCurrent(token) || !this.activeRun) return false;
    this.activeRun = { ...this.activeRun, taskId };
    return true;
  }

  complete(token: number) {
    if (!this.isCurrent(token)) return false;
    this.activeRun = null;
    return true;
  }

  stop() {
    const stoppedRun = this.activeRun;
    this.sequence += 1;
    this.activeRun = null;
    return stoppedRun;
  }
}
