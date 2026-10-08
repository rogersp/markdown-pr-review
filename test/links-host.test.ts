import assert from 'node:assert/strict';
import { resolveLink, isMarkdownPath } from '../src/links';

const cur = 'docs/design/plan.md';

assert.deepEqual(resolveLink(cur, './scenarios.md#s11'), { kind: 'file', relPath: 'docs/design/scenarios.md', fragment: 's11' });
assert.deepEqual(resolveLink(cur, 'scenarios.md'), { kind: 'file', relPath: 'docs/design/scenarios.md', fragment: undefined });
assert.deepEqual(resolveLink(cur, '../other/x.md'), { kind: 'file', relPath: 'docs/other/x.md', fragment: undefined });
assert.deepEqual(resolveLink(cur, '/README.md'), { kind: 'file', relPath: 'README.md', fragment: undefined });
assert.deepEqual(resolveLink(cur, '#q1'), { kind: 'file', relPath: cur, fragment: 'q1' });
assert.deepEqual(resolveLink(cur, './x.md?plain=1#L3'), { kind: 'file', relPath: 'docs/design/x.md', fragment: 'L3' });
assert.deepEqual(resolveLink(cur, 'my%20file.md'), { kind: 'file', relPath: 'docs/design/my file.md', fragment: undefined });

assert.equal(resolveLink(cur, '../../../outside.md').kind, 'invalid');
assert.equal(resolveLink(cur, '//evil/x.md').kind, 'invalid');

assert.deepEqual(resolveLink(cur, 'https://github.com/a/b'), { kind: 'external', url: 'https://github.com/a/b' });
assert.deepEqual(resolveLink(cur, 'mailto:a@example.com'), { kind: 'external', url: 'mailto:a@example.com' });
assert.equal(resolveLink(cur, 'javascript:alert(1)').kind, 'invalid');
assert.equal(resolveLink(cur, 'vscode://some.ext/run').kind, 'invalid');

assert.equal(isMarkdownPath('a/b.md'), true);
assert.equal(isMarkdownPath('a/b.MARKDOWN'), true);
assert.equal(isMarkdownPath('a/b.svg'), false);

console.log('All links-host tests passed ✓');
