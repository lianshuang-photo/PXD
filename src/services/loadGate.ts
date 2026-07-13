export class LatestLoadGate {
  private generation = 0;
  private ready = false;

  begin(): number {
    this.ready = false;
    this.generation += 1;
    return this.generation;
  }

  isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  complete(generation: number): boolean {
    if (!this.isCurrent(generation)) {
      return false;
    }
    this.ready = true;
    return true;
  }

  assertReady(message: string): void {
    if (!this.ready) {
      throw new Error(message);
    }
  }
}
