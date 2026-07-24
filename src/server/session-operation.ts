interface SessionState { locked: boolean; queue: Array<() => void> }

export class SessionOperationCoordinator {
  private readonly states = new Map<string, SessionState>();

  async runGeneration<T>(recordId: string, operation: () => Promise<T>): Promise<T> {
    const state = this.states.get(recordId);
    if (state?.locked || state?.queue.length) throw new Error("SESSION_BUSY");
    const acquired = state ?? { locked: false, queue: [] }; acquired.locked = true; this.states.set(recordId, acquired);
    try { return await operation(); } finally { this.release(recordId, acquired); }
  }

  async runExclusive<T>(recordId: string, operation: () => Promise<T>): Promise<T> {
    return await this.runGeneration(recordId, operation);
  }

  async runCommand<T>(recordId: string, operation: () => Promise<T>): Promise<T> {
    const state = this.states.get(recordId) ?? { locked: false, queue: [] }; this.states.set(recordId, state);
    if (state.locked) await new Promise<void>(resolve => state.queue.push(resolve));
    else state.locked = true;
    try { return await operation(); } finally { this.release(recordId, state); }
  }

  private release(recordId: string, state: SessionState): void {
    const next = state.queue.shift();
    if (next) { next(); return; }
    state.locked = false; if (this.states.get(recordId) === state) this.states.delete(recordId);
  }
}
