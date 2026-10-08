import assert from 'node:assert/strict';
import { prepareDraftComments } from '../src/drafts';

const suffix = (rawLine: number) => `\n\n---\n*Comment on line ${rawLine}*`;
// b.md's line 10 is outside the diff and snaps to 7; a.md's lines are all valid.
const snap = (path: string, line: number) => (path === 'b.md' ? 7 : line);

const out = prepareDraftComments(
  [
    { path: 'a.md', line: 4, body: 'one' },
    { path: 'b.md', line: 9, body: 'two' },
  ],
  snap,
  suffix
);

assert.deepEqual(out, [
  { path: 'a.md', line: 5, body: 'one' },
  { path: 'b.md', line: 7, body: 'two\n\n---\n*Comment on line 10*' },
]);

console.log('All drafts tests passed ✓');
