import assert from 'node:assert/strict';
import { ReviewSession, type SessionChange, type SessionContext, type SessionView } from '../src/ReviewSession';

class FakeView implements SessionView {
  changes: SessionChange[] = [];
  constructor(public filePath: string) {}
  onSessionChange(change: SessionChange): void {
    this.changes.push(change);
  }
}

const last = (v: FakeView) => v.changes[v.changes.length - 1];

const ctx: SessionContext = {
  owner: 'o', repo: 'r', prNumber: 7, headSha: 'abc', repoRoot: '/repo',
  prFiles: [{ path: 'a.md', openCount: 0, resolvedCount: 0 }],
  validLinesByPath: new Map(), currentUserLogin: 'me',
};

const s = new ReviewSession<FakeView>(ctx);
const a = new FakeView('a.md');
const b = new FakeView('b.md');
const a2 = new FakeView('a.md');

// The newest panel is active until another is focused.
s.attach(a);
assert.equal(s.active, a);
s.attach(b);
s.attach(a2);
assert.equal(s.active, a2);
s.setActive(b);
assert.equal(s.active, b);

// Drafts are shared by every panel; each hears the new count.
s.addDraft({ path: 'a.md', line: 3, body: 'x' });
s.addDraft({ path: 'b.md', line: 1, body: 'y' });
assert.equal(s.draftCount, 2);
assert.deepEqual(last(a), { kind: 'drafts', count: 2 });
assert.deepEqual(last(b), { kind: 'drafts', count: 2 });
s.clearDrafts();
assert.deepEqual(last(a2), { kind: 'drafts', count: 0 });

// A comment change reaches only the other panels showing that file.
[a, b, a2].forEach(v => { v.changes = []; });
s.commentsChanged('a.md', a);
assert.deepEqual(a.changes, []);
assert.deepEqual(b.changes, []);
assert.deepEqual(a2.changes, [{ kind: 'comments', path: 'a.md' }]);

// Closing the active panel hands focus to the most recently opened remaining one.
s.detach(b);
assert.equal(s.active, a2);
assert.equal(s.viewCount, 2);
s.detach(a);
s.detach(a2);
assert.equal(s.active, undefined);
assert.equal(s.viewCount, 0);

// The same PR keeps its session and drafts when the review is re-opened.
assert.equal(s.isSameReview({ ...ctx, headSha: 'def' }), true);
assert.equal(s.isSameReview({ ...ctx, prNumber: 8 }), false);
s.addDraft({ path: 'a.md', line: 0, body: 'z' });
s.refresh({ ...ctx, headSha: 'def' });
assert.equal(s.draftCount, 1);
assert.equal(s.ctx.headSha, 'def');

console.log('All review-session tests passed ✓');
