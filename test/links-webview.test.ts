import assert from 'node:assert/strict';
import { classifyHref, decodeFragment } from '../webview/links';

assert.deepEqual(classifyHref(null), { kind: 'ignore' });
assert.deepEqual(classifyHref('#'), { kind: 'ignore' });
assert.deepEqual(classifyHref('#55-composing-templates'), { kind: 'fragment', id: '55-composing-templates' });
assert.deepEqual(classifyHref('#caf%C3%A9'), { kind: 'fragment', id: 'café' });
assert.deepEqual(classifyHref('./other.md#s2'), { kind: 'host', href: './other.md#s2' });
assert.deepEqual(classifyHref('https://github.com'), { kind: 'host', href: 'https://github.com' });

// Malformed percent-encoding falls back to the raw text.
assert.equal(decodeFragment('100%-done'), '100%-done');

console.log('All links-webview tests passed ✓');
