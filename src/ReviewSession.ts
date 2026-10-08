import type { PrFile } from './types';
import type { DraftComment } from './drafts';

export interface SessionContext {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  repoRoot: string;
  prFiles: PrFile[];
  validLinesByPath: Map<string, number[]>;
  currentUserLogin: string;
}

export type SessionChange =
  | { kind: 'drafts'; count: number }
  | { kind: 'comments'; path: string };

export interface SessionView {
  readonly filePath: string;
  onSessionChange(change: SessionChange): void;
}

// State shared by every review panel open on one PR: the PR context, the pending review's
// draft comments, and the panel the reader last focused. Free of the vscode API so it can
// be unit-tested.
export class ReviewSession<V extends SessionView = SessionView> {
  private _ctx: SessionContext;
  private _drafts: DraftComment[] = [];
  private readonly _views = new Set<V>();
  private _active: V | undefined;

  constructor(ctx: SessionContext) {
    this._ctx = ctx;
  }

  get ctx(): SessionContext {
    return this._ctx;
  }

  isSameReview(ctx: SessionContext): boolean {
    return ctx.owner === this._ctx.owner && ctx.repo === this._ctx.repo && ctx.prNumber === this._ctx.prNumber;
  }

  // Re-opening the review on the same PR picks up new commits and keeps the drafts.
  refresh(ctx: SessionContext): void {
    this._ctx = ctx;
  }

  get prFiles(): PrFile[] {
    return this._ctx.prFiles;
  }

  set prFiles(files: PrFile[]) {
    this._ctx = { ...this._ctx, prFiles: files };
  }

  get views(): V[] {
    return [...this._views];
  }

  get viewCount(): number {
    return this._views.size;
  }

  get active(): V | undefined {
    return this._active;
  }

  attach(view: V): void {
    this._views.add(view);
    this._active = view;
  }

  setActive(view: V): void {
    if (this._views.has(view)) this._active = view;
  }

  detach(view: V): void {
    this._views.delete(view);
    if (this._active === view) {
      const remaining = this.views;
      this._active = remaining[remaining.length - 1];
    }
  }

  get drafts(): readonly DraftComment[] {
    return this._drafts;
  }

  get draftCount(): number {
    return this._drafts.length;
  }

  addDraft(draft: DraftComment): void {
    this._drafts.push(draft);
    this._broadcast({ kind: 'drafts', count: this._drafts.length });
  }

  clearDrafts(): void {
    this._drafts = [];
    this._broadcast({ kind: 'drafts', count: 0 });
  }

  // Tells the other panels showing `path` that its comments changed.
  commentsChanged(path: string, source: V): void {
    for (const view of this._views) {
      if (view !== source && view.filePath === path) view.onSessionChange({ kind: 'comments', path });
    }
  }

  private _broadcast(change: SessionChange): void {
    this._views.forEach(view => view.onSessionChange(change));
  }
}
