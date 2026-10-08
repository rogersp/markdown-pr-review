import assert from 'node:assert/strict';
import { visibleOutline, countOpenThreadsBySection, activeHeadingIndex, type OutlineItem } from '../webview/outline-model';

const h = (level: number, id: string, text: string, line: number): OutlineItem =>
  ({ level, id, text, line, openThreads: 0 });

const items = [
  h(1, 'title', 'Design guidance', 0),
  h(2, '5-recommendation', '5. Recommendation', 10),
  h(3, '51-the-message-lifecycle', '5.1 The message lifecycle', 20),
  h(4, 'figure-1', 'Figure 1 · The message lifecycle', 25),
  h(2, '6-detail', '6. Detail', 40),
];

// Depth limits levels; a query searches every level, case-insensitively.
assert.deepEqual(visibleOutline(items, 2, '').map(i => i.id), ['title', '5-recommendation', '6-detail']);
assert.deepEqual(visibleOutline(items, 3, '').map(i => i.id),
  ['title', '5-recommendation', '51-the-message-lifecycle', '6-detail']);
assert.deepEqual(visibleOutline(items, 2, '  LIFECYCLE ').map(i => i.id), ['51-the-message-lifecycle', 'figure-1']);

// Section ranges: title [0,∞), 5 [10,40), 5.1 [20,40), fig [25,40), 6 [40,∞).
assert.deepEqual(countOpenThreadsBySection(items, [22, 26, 45, 5]), [4, 2, 2, 1, 1]);
assert.deepEqual(countOpenThreadsBySection([], [3]), []);

// Active heading: the last one whose top is at or above the scroll position plus the header offset.
assert.equal(activeHeadingIndex([100, 500, 900], 0, 50), -1);
assert.equal(activeHeadingIndex([100, 500, 900], 60, 50), 0);
assert.equal(activeHeadingIndex([100, 500, 900], 460, 50), 1);
assert.equal(activeHeadingIndex([100, 500, 900], 5000, 50), 2);

console.log('All outline-model tests passed ✓');
