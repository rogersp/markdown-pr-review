export interface HistoryLocation {
  path: string;
  scrollTop: number;
}

// Browser-style back/forward lists. Each entry is where the reader was when they left it.
// Callers peek, show the target, and commit only if showing it succeeded.
export class NavHistory {
  private readonly _limit: number;
  private readonly _back: HistoryLocation[] = [];
  private _forward: HistoryLocation[] = [];

  constructor(limit = 100) {
    this._limit = limit;
  }

  get canGoBack(): boolean {
    return this._back.length > 0;
  }

  get canGoForward(): boolean {
    return this._forward.length > 0;
  }

  push(current: HistoryLocation): void {
    this._back.push(current);
    if (this._back.length > this._limit) this._back.shift();
    this._forward = [];
  }

  peekBack(): HistoryLocation | undefined {
    return this._back[this._back.length - 1];
  }

  peekForward(): HistoryLocation | undefined {
    return this._forward[this._forward.length - 1];
  }

  commitBack(current: HistoryLocation): void {
    if (this._back.pop()) this._forward.push(current);
  }

  commitForward(current: HistoryLocation): void {
    if (this._forward.pop()) this._back.push(current);
  }
}
