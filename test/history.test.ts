import assert from 'node:assert/strict';
import { NavHistory } from '../src/history';

const a = { path: 'a.md', scrollTop: 0 };
const b = { path: 'a.md', scrollTop: 900 };
const c = { path: 'b.md', scrollTop: 0 };

const h = new NavHistory();
assert.equal(h.canGoBack, false);
assert.equal(h.canGoForward, false);
assert.equal(h.peekBack(), undefined);

// Following a link from a records a.
h.push(a);
assert.equal(h.canGoBack, true);
assert.deepEqual(h.peekBack(), a);

// Going back while at b: a is shown, b becomes the forward entry.
h.commitBack(b);
assert.equal(h.canGoBack, false);
assert.deepEqual(h.peekForward(), b);

// Going forward again while at a.
h.commitForward(a);
assert.deepEqual(h.peekBack(), a);
assert.equal(h.canGoForward, false);

// A new navigation clears the forward list.
h.commitBack(b);
assert.equal(h.canGoForward, true);
h.push(a);
assert.equal(h.canGoForward, false);

// Committing with nothing to pop changes nothing.
const empty = new NavHistory();
empty.commitBack(c);
assert.equal(empty.canGoForward, false);

// The back list is capped, dropping the oldest entries.
const capped = new NavHistory(3);
for (let i = 0; i < 5; i++) capped.push({ path: 'a.md', scrollTop: i });
assert.deepEqual(capped.peekBack(), { path: 'a.md', scrollTop: 4 });
let steps = 0;
while (capped.canGoBack) {
  capped.commitBack(c);
  steps++;
}
assert.equal(steps, 3);

console.log('All history tests passed ✓');
