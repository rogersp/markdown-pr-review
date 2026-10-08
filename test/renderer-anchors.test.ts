import assert from 'node:assert/strict';
import { renderMarkdown } from '../webview/renderer';

// Anchor inside a heading becomes a real element; the heading slug ignores it.
const heading = renderMarkdown('## <a id="s1"></a>S1 · Scenario one\n');
assert.ok(heading.includes('<a id="s1"></a>'), 'heading anchor must render as an element');
assert.ok(!heading.includes('&lt;a'), 'heading anchor must not appear as escaped text');
assert.match(heading, /<h2 id="s1-+scenario-one"/, 'heading slug must not include the anchor markup');

// Anchor in a table cell.
const table = renderMarkdown('| ID | Q |\n|----|---|\n| <a id="q1"></a>Q1 | text |\n');
assert.ok(table.includes('<a id="q1"></a>Q1'), 'table-cell anchor must render as an element');

// Legacy name= form is emitted as id=.
const legacy = renderMarkdown('<a name="legacy"></a>\nText.\n');
assert.ok(legacy.includes('<a id="legacy"></a>'), 'name= anchor must render with an id');

// Anything other than an empty id/name anchor stays escaped.
const href = renderMarkdown('<a href="javascript:alert(1)">x</a>\n');
assert.ok(!href.includes('<a href="javascript'), 'an <a href> must not become live HTML');
const extraAttr = renderMarkdown('<a id="x" onclick="evil()"></a>\n');
assert.ok(!extraAttr.includes('<a id="x"'), 'an anchor with other attributes must stay escaped');

// Regression guard: numbered headings keep GitHub's slug.
const numbered = renderMarkdown('### 5.2 The envelope — one row per outbound email\n');
assert.match(numbered, /<h3 id="52-the-envelope--one-row-per-outbound-email"/);

console.log('All renderer-anchors tests passed ✓');
