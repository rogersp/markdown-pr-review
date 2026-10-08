# Link Navigation, History and Outline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> Steps marked **Manual check (human)** need a person at VS Code, because they drive the Extension Development Host against a live GitHub PR. An agent stops at these steps and asks the human to run them and report back. It never marks one done itself.

**Goal:** In a fork of `FrankLedo/markdown-pr-review`, make every link in a rendered markdown file work: links within the file, `<a id>` anchors, and relative links to other files. Then add browser-style back/forward, a heading outline, and the option to open a link in a new review panel.

**Architecture:** The bug fixes stay small and in the existing shape. The renderer gets one inline rule for named anchors. The webview routes link clicks through a pure `classifyHref`. Links to other files go to the extension host, where a pure `resolveLink` turns them into a repo-relative path, and they are loaded through the existing `_loadAndRender`. Navigation history lives in the host (`NavHistory`, pure), because the host is the only part that outlives both a file switch and the webview being re-created when its tab is hidden. The outline is built inside the webview from the rendered headings, and its logic is in a pure module (`outline-model.ts`) so it can be tested without a DOM. Last, the singleton `ReviewPanel` is split. A `ReviewSession` per PR holds the PR context and draft comments, and one `ReviewPanel` per tab holds its file and history. That lets a link open in a second panel without splitting the review in two.

**Tech Stack:** TypeScript, VS Code extension API (engine `^1.85.0`), webview bundled by esbuild, markdown-it 14 with markdown-it-anchor 9 and github-slugger 2, tests as plain `npx tsx` scripts using `node:assert/strict`.

**Spec:** the [Background](#background) section of this document. It records the analysis that led to this plan.

## Global Constraints

- Base: upstream `FrankLedo/markdown-pr-review`, commit `d9861b6196b3c8250fe323212595525dccf7c1cc` (v1.6.11). Line numbers below refer to that commit. If they have drifted, find the code by the quoted text.
- Tests are `npx tsx test/<name>.test.ts` scripts using `node:assert/strict`, chained in the `test` script of `package.json`. There is no DOM in tests. Logic goes in pure modules, and DOM code stays thin.
- No new runtime or dev dependencies.
- Keep `name`, `publisher` and the existing command ids unchanged on the fix and feature branches, so they can be offered upstream as PRs. Fork identity changes happen only on the `fork-build` branch (Task 7).
- The fork is public. Never commit private or client documents to it, not even as test fixtures. Use the synthetic fixtures from Task 0.
- Match the house style: 2-space indent, single quotes, semicolons, comments only where the reason is not obvious. CSS lives in `ReviewPanel._buildHtml()`. CSS classes are prefixed `pr-`. Webview → host message types are added to `WebviewMessage`, and host → webview ones to `ExtensionMessage`, both in `src/types.ts`.
- Use only VS Code APIs available in 1.85: `vscode.open` with `TextDocumentShowOptions`, `vscode.env.openExternal`, the `activeWebviewPanelId` context key.
- The extension's one setting is `markdownPrReview.openLinks`, `"inPanel"` (default) or `"newPanel"` (Task 8).
- The webview panel id is `markdownPrReview`, from `createWebviewPanel` in `src/ReviewPanel.ts:55`.

---

## Background

When a large design document (2,200 lines, numbered headings, cross-file links) was viewed in the review panel, none of its links worked. Reading the source at `d9861b6` shows three defects:

1. **Links to sections in the same file fail.** `webview/main.ts:370-377` handles clicks with `document.querySelector(href)`. Heading ids come from github-slugger (`webview/renderer.ts:64-67`) and are correct. But an id such as `55-composing-templates` starts with a digit, which is not a valid CSS id selector. `querySelector` throws a `SyntaxError`, and because `preventDefault()` has already run, the click does nothing. Every numbered heading is affected. The fix is `getElementById` on the decoded fragment.
2. **Explicit anchors are never created.** The renderer uses `new MarkdownIt({ html: false })` (`renderer.ts:59`), so `<a id="q1"></a>` and `<a name="x"></a>` come out as escaped text. A heading written `## <a id="s2"></a>S2 · …` shows the tag as literal text. The fix is a narrow inline rule that accepts only an empty `<a id|name="…"></a>` and emits a real anchor. Other HTML stays escaped.
3. **Links to other files go nowhere.** The click handler ignores any `href` that does not start with `#`. The webview's default navigation is blocked by VS Code, and the host has no message for opening a file (`ReviewPanel._handleMessage` handles only `ready`, `switchFile` and the comment and review messages). The fix is a new `openLink` message, resolved by the host against the current file, then shown with `_loadAndRender` and a scroll.

Two existing defects block cross-file navigation and are fixed first:

- **Switching files throws away draft comments.** `_loadAndRender` sets `this._draftComments = []` (`ReviewPanel.ts:147`), and `submitReview` posts every draft against `this._filePath`. Separately, the webview runs `draft?.clear()` on every render (`main.ts:363`). So when the panel's tab is hidden and shown again, the "pending comments" badge disappears even though the host still holds the drafts.
- **The initial render message omits `validLines`** (`ReviewPanel.ts:100-112`). The webview falls back to `[]`.

Features:

- **Back/forward.** The browser's own history cannot be used, because a file switch replaces the content through `postMessage`, not by loading a page. The host keeps browser-style lists. Each entry is `{ path, scrollTop }`, recorded as "where the reader was when they left". Controls: ← and → buttons in the header; the commands `markdown-pr-review.navigateBack` and `markdown-pr-review.navigateForward`, bound to Alt+←/Alt+→ (Ctrl+- / Ctrl+Shift+- on macOS) while the panel is active; and the mouse's back/forward buttons where the platform delivers them. Uncertain: that last one is unverified in VS Code webviews.
- **Outline.** A collapsible panel inside the webview, built from the rendered headings. It has a depth selector (H2, H3, H4, All) and a text filter. It highlights the current section as you scroll, and shows the number of open comment threads in each section, which is the review-specific part. Clicking an entry records history, so Back returns to where you were. VS Code's own Outline view was rejected: it follows the active text editor and shows nothing when a webview has focus.
- **Open in a new panel.** A plain click follows a link in the same panel, as VS Code's markdown preview does by default. Cmd/Ctrl-click or middle-click opens the linked file in a new review panel beside it, with its own history, so the plan and a scenario can be read side by side. The setting `markdownPrReview.openLinks` swaps the two. Opening every link in a new panel by default was rejected: it multiplies tabs and repeated GitHub fetches, and it turns Back into a tab switch. Two panels need shared state, so draft comments and comment changes move to a per-PR `ReviewSession`. Otherwise each panel would build its own review, and one panel's view goes stale when the other resolves a thread. A separate OS window is left to VS Code's "Move Editor into New Window". Uncertain: whether review panels work correctly there is unverified.

## File map

| File | Change | Task |
|---|---|---|
| `test/fixtures/navigation/index.md`, `other.md` | Create: synthetic documents for manual checks | 0 |
| `webview/renderer.ts` | Named-anchor inline rule | 1 |
| `test/renderer-anchors.test.ts` | Create | 1 |
| `webview/links.ts` | Create: `classifyHref`, `decodeFragment` | 2 |
| `test/links-webview.test.ts` | Create | 2 |
| `webview/main.ts` | Link routing, scrolling, drafts, history, outline wiring | 2–6 |
| `src/ReviewPanel.ts` | Drafts per file, `openLink`, `_show`, history, CSS | 2–6 |
| `src/drafts.ts` | Create: `prepareDraftComments` | 3 |
| `test/drafts.test.ts` | Create | 3 |
| `src/types.ts` | Message and field additions | 3–5 |
| `src/GitHubClient.ts` | `mapComment` keeps `path` | 3 |
| `webview/draft.ts` | `DraftManager` takes an initial count | 3 |
| `src/links.ts` | Create: `resolveLink`, `isMarkdownPath` | 4 |
| `test/links-host.test.ts` | Create | 4 |
| `webview/overlay.ts` | Read-only mode for files outside the PR | 4 |
| `src/history.ts` | Create: `NavHistory` | 5 |
| `test/history.test.ts` | Create | 5 |
| `webview/history-controls.ts` | Create: back/forward buttons | 5 |
| `src/extension.ts` | Register back/forward commands | 5 |
| `package.json` | Test script; commands and keybindings (5); fork identity (7) | 1–7 |
| `webview/outline-model.ts` | Create: pure outline logic | 6 |
| `test/outline-model.test.ts` | Create | 6 |
| `webview/outline.ts` | Create: `OutlinePanel` | 6 |
| `src/ReviewSession.ts` | Create: per-PR shared state | 8 |
| `test/review-session.test.ts` | Create | 8 |
| `src/ReviewPanel.ts`, `src/extension.ts` | Singleton → panels sharing a session | 8 |
| `src/links.ts`, `webview/main.ts`, `webview/draft.ts` | `opensNewPanel`; modifier and middle click; `setCount` | 8 |

Branches:
- Tasks 0–4 go on `fix/link-navigation`, which can be offered upstream.
- Tasks 5–6 go on `feat/navigation`, cut from it.
- Task 7 goes on `fork-build`, cut from `feat/navigation`.
- Task 8 goes on `feat/multi-panel`, also cut from `feat/navigation`, and is merged into `fork-build` at its last step.

---

### Task 0: Fork, baseline and test fixtures

**Files:**
- Create: `test/fixtures/navigation/index.md`, `test/fixtures/navigation/other.md`
- Create: `docs/superpowers/plans/2026-10-07-link-navigation-history-outline.md` (this plan)

**Interfaces:**
- Produces: a clone whose `origin` is the fork (`src/GitContext.ts` reads `origin`), a branch `fix/link-navigation` with an open draft PR in the fork, and two fixture files that every manual check uses.

- [ ] **Step 1: Fork and clone**

```bash
gh repo fork FrankLedo/markdown-pr-review --clone --remote
cd markdown-pr-review
git remote -v
```
Expected: `origin` is `<you>/markdown-pr-review` and `upstream` is `FrankLedo/markdown-pr-review`.

- [ ] **Step 2: Install and record the baseline**

```bash
npm install
npm test
npm run compile
npx tsc -p tsconfig.json --noEmit > ../tsc-baseline-ext.txt 2>&1; echo "ext exit $?"
npx tsc -p tsconfig.webview.json --noEmit > ../tsc-baseline-webview.txt 2>&1; echo "webview exit $?"
```
Expected: `npm test` prints four `… tests passed ✓` lines, and compile prints `Build complete.`. The two type-check runs may already report errors. For example, `RenderMessage.validLines` is missing in `ReviewPanel.render()`. The baseline files are kept outside the repo, so later tasks can confirm they add no new type errors.

- [ ] **Step 3: Point the debug launch at this folder, without committing it**

`.vscode/launch.json` opens the upstream author's own folder (`"/Users/fxl/pr-review"`). In the `args` array, replace that string with `"${workspaceFolder}"`. Then stop git from tracking the change:

```bash
git update-index --skip-worktree .vscode/launch.json
```

- [ ] **Step 4: Create the branch and the fixtures**

```bash
git switch -c fix/link-navigation
mkdir -p test/fixtures/navigation docs/superpowers/plans
node --input-type=module <<'EOF'
import { writeFileSync } from 'node:fs';
const filler = (n) => Array.from({ length: n }, (_, i) =>
  `Filler paragraph ${i + 1}. This text exists so the document is long enough to scroll; navigation checks need a target that starts off-screen.`).join('\n\n');
const index = `# Navigation fixture

Links in this file exercise every kind of link the review panel must follow.

## Contents

- [1. Overview](#1-overview)
- [5.2 The envelope — one row per outbound email](#52-the-envelope--one-row-per-outbound-email)
- [5.5 Composing: templates, tokens](#55-composing-templates-tokens)
- [Open question Q1](#q1)
- [Scenario S2 in the other file](./other.md#s2)
- [The other file, top](./other.md)
- [The repository README (not in this PR)](../../../README.md)
- [A file that is not markdown](../../../package.json)
- [A link that leaves the repository](../../../../outside.md)
- [A missing anchor](#no-such-heading)
- [GitHub](https://github.com)

## 1. Overview

${filler(12)}

## 5. Recommendation

${filler(6)}

### 5.2 The envelope — one row per outbound email

${filler(12)}

### 5.5 Composing: templates, tokens

${filler(12)}

## 10. Open questions

| ID | Question |
|----|----------|
| <a id="q1"></a>Q1 | Does a table-cell anchor scroll into view? See [5.2](#52-the-envelope--one-row-per-outbound-email). |
| <a id="q2"></a>Q2 | Does a legacy named anchor work? See [the legacy anchor](#legacy). |

<a name="legacy"></a>
${filler(8)}
`;
const other = `# Other fixture file

[Back to the overview in index.md](./index.md#1-overview)

## <a id="s1"></a>S1 · First scenario

${filler(12)}

## <a id="s2"></a>S2 · Second scenario

${filler(12)}

See [Q1 in index.md](./index.md#q1).
`;
writeFileSync('test/fixtures/navigation/index.md', index);
writeFileSync('test/fixtures/navigation/other.md', other);
EOF
```
Copy this plan to `docs/superpowers/plans/2026-10-07-link-navigation-history-outline.md`.

- [ ] **Step 5: Commit, push, open a draft PR in the fork**

The extension only opens on a branch that has an open PR (`findPrNumber`, `src/GitHubClient.ts:72`), and only files in that PR can be commented on.

```bash
git add test/fixtures/navigation docs/superpowers/plans/2026-10-07-link-navigation-history-outline.md
git commit -m "test: add navigation fixtures and implementation plan"
git push -u origin fix/link-navigation
gh pr create --repo "$(gh repo view --json nameWithOwner -q .nameWithOwner)" --base main --head fix/link-navigation --draft --title "Link navigation fixes" --body "Test PR for the link-navigation work. Not for merge."
```
Expected: the PR URL is printed and is in the fork, not upstream.

- [ ] **Step 6: Manual check (human): baseline behaviour**

Run `npm run compile`, then press F5 ("Run Extension"). In the Extension Development Host, open `test/fixtures/navigation/index.md` and run **Markdown PR Review: Open Review Panel**. Click "5.2 The envelope…" in Contents. Expected today: nothing happens. "Q1" shows `<a id="q1"></a>` as literal text in the table. This confirms the defects before any fix.

---

### Task 1: Render empty named anchors

**Files:**
- Modify: `webview/renderer.ts` (imports at lines 1-7; rule setup after line 62)
- Create: `test/renderer-anchors.test.ts`
- Modify: `package.json` (`scripts.test`)

**Interfaces:**
- Produces: rendered HTML contains `<a id="X"></a>` for every source `<a id="X"></a>` or `<a name="X"></a>`. Heading ids stay GitHub-compatible and are not affected by an anchor inside the heading.

- [ ] **Step 1: Write the failing test**

Create `test/renderer-anchors.test.ts`:

```ts
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
```

Append ` && npx tsx test/renderer-anchors.test.ts` to the end of `scripts.test` in `package.json`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx test/renderer-anchors.test.ts`
Expected: FAIL with `AssertionError [ERR_ASSERTION]: heading anchor must render as an element`.

- [ ] **Step 3: Implement the inline rule**

In `webview/renderer.ts`, add this import after the `StateBlock` import:

```ts
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs';
```

Add this above `export function renderMarkdown`:

```ts
// html:false escapes all raw HTML, which also escapes the empty anchors documents use as
// link targets (`<a id="q1"></a>`). Accept exactly that shape — one id or name attribute,
// no content — and emit a real anchor. Everything else stays escaped.
const NAMED_ANCHOR_RE = /^<a\s+(?:id|name)\s*=\s*"([^"<>]+)"\s*>\s*<\/a>/i;

function namedAnchorRule(state: StateInline, silent: boolean): boolean {
  if (state.src.charCodeAt(state.pos) !== 0x3c /* < */) return false;
  const match = NAMED_ANCHOR_RE.exec(state.src.slice(state.pos));
  if (!match) return false;
  if (!silent) {
    const token = state.push('named_anchor', '', 0);
    token.meta = { id: match[1] };
  }
  state.pos += match[0].length;
  return true;
}
```

In `renderMarkdown`, directly after the two `front_matter` lines (`md.renderer.rules['front_matter'] = …`), add:

```ts
  // Registered before markdown-it-anchor runs; the token carries no text, so heading
  // slugs are computed from the visible heading text only.
  md.inline.ruler.before('autolink', 'named_anchor', namedAnchorRule);
  md.renderer.rules['named_anchor'] = (tokens, idx) =>
    `<a id="${escapeHtml(String(tokens[idx].meta.id))}"></a>`;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS. Five `… tests passed ✓` lines, including `All renderer-anchors tests passed ✓`.

- [ ] **Step 5: Commit**

```bash
git add webview/renderer.ts test/renderer-anchors.test.ts package.json
git commit -m "fix: render empty <a id> and <a name> anchors as link targets"
```

---

### Task 2: Fragment links scroll to their target

**Files:**
- Create: `webview/links.ts`, `test/links-webview.test.ts`
- Modify: `webview/main.ts` (imports; helpers after `showToast` at line 85; the click handler at lines 368-377)
- Modify: `src/ReviewPanel.ts` (`_buildHtml` CSS after line 344)
- Modify: `package.json` (`scripts.test`)

**Interfaces:**
- Consumes: anchor elements from Task 1.
- Produces, `webview/links.ts`:
  - `type LinkAction = { kind: 'fragment'; id: string } | { kind: 'host'; href: string } | { kind: 'ignore' }`
  - `classifyHref(href: string | null): LinkAction`
  - `decodeFragment(raw: string): string`
- Produces, `webview/main.ts` (module-level functions used by later tasks):
  - `findFragmentTarget(id: string): HTMLElement | null`
  - `revealFragment(id: string): void`. Scrolls to the target and highlights it, or shows a toast if the id is missing. It does not record history.
  - `flash(el: HTMLElement): void`

- [ ] **Step 1: Write the failing test**

Create `test/links-webview.test.ts`:

```ts
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
```

Append ` && npx tsx test/links-webview.test.ts` to `scripts.test`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx test/links-webview.test.ts`
Expected: FAIL with `Cannot find module '../webview/links'` (or `ERR_MODULE_NOT_FOUND`).

- [ ] **Step 3: Implement `webview/links.ts`**

```ts
export type LinkAction =
  | { kind: 'fragment'; id: string }
  | { kind: 'host'; href: string }
  | { kind: 'ignore' };

// Same-file fragments are handled in the webview; every other link needs the host.
export function classifyHref(href: string | null): LinkAction {
  if (!href) return { kind: 'ignore' };
  if (href.startsWith('#')) {
    const id = decodeFragment(href.slice(1));
    return id ? { kind: 'fragment', id } : { kind: 'ignore' };
  }
  return { kind: 'host', href };
}

export function decodeFragment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx test/links-webview.test.ts`
Expected: `All links-webview tests passed ✓`

- [ ] **Step 5: Route fragment clicks in `webview/main.ts`**

Add to the imports:

```ts
import { classifyHref } from './links';
```

Add after `showToast` (line 85):

```ts
function flash(el: HTMLElement): void {
  el.classList.remove('pr-nav-highlight');
  void el.offsetWidth; // force reflow so the animation restarts on repeated jumps
  el.classList.add('pr-nav-highlight');
  el.addEventListener('animationend', () => el.classList.remove('pr-nav-highlight'), { once: true });
}

// getElementById, not querySelector: heading slugs such as "55-composing" start with a
// digit, which is not a valid CSS id selector.
function findFragmentTarget(id: string): HTMLElement | null {
  return document.getElementById(id) ?? document.getElementById(id.toLowerCase());
}

function revealFragment(id: string): void {
  const target = findFragmentTarget(id);
  if (!target) {
    showToast(`No heading or anchor "#${id}" in this file`);
    return;
  }
  target.scrollIntoView({ block: 'start' });
  flash((target.closest('[data-line]') as HTMLElement | null) ?? target);
}
```

In `handleRender`, replace:

```ts
    initSelectionHandlers(contentEl, onAddComment, () => validLines);
    // VS Code webviews intercept all link navigation including #anchor same-page
    // links. Handle them manually so TOC links scroll to the correct heading.
    document.addEventListener('click', (e) => {
      const a = (e.target as Element).closest('a');
      if (!a) return;
      const href = a.getAttribute('href');
      if (!href?.startsWith('#')) return;
      e.preventDefault();
      document.querySelector(href)?.scrollIntoView({ behavior: 'smooth' });
    });
    selectionHandlersReady = true;
```

with:

```ts
    initSelectionHandlers(contentEl, onAddComment, () => validLines);
    selectionHandlersReady = true;
```

Add after the `keydown` listener (after line 214):

```ts
// VS Code webviews block link navigation, so links are routed here.
document.addEventListener('click', (e) => {
  const a = (e.target as Element).closest('a');
  if (!a) return;
  const action = classifyHref(a.getAttribute('href'));
  if (action.kind !== 'fragment') return;
  e.preventDefault();
  revealFragment(action.id);
});
```

- [ ] **Step 6: Keep targets clear of the sticky header**

In `src/ReviewPanel.ts` `_buildHtml`, add this after the `#content { … }` rule (line 344):

```css
    .pr-content h1, .pr-content h2, .pr-content h3,
    .pr-content h4, .pr-content h5, .pr-content h6,
    .pr-content a[id] { scroll-margin-top: 64px; }
```

- [ ] **Step 7: Build and test**

Run: `npm test && npm run compile`
Expected: six `passed ✓` lines, then `Build complete.`

- [ ] **Step 8: Manual check (human)**

Reload the Extension Development Host (Developer: Reload Window) and open the panel on `index.md`. In Contents, click "1. Overview", "5.2 The envelope…" and "5.5 Composing…". Expected: each heading scrolls to just below the header and flashes. "Open question Q1": the Q1 row scrolls into view. In that table, "the legacy anchor": scrolls to the paragraph after the table. "A missing anchor": a toast says `No heading or anchor "#no-such-heading" in this file`. "GitHub" still opens the browser, because it is not intercepted yet.

- [ ] **Step 9: Commit**

```bash
git add webview/links.ts webview/main.ts src/ReviewPanel.ts test/links-webview.test.ts package.json
git commit -m "fix: scroll fragment links with getElementById so digit-leading slugs work"
```

---

### Task 3: Draft comments survive file switches

**Files:**
- Create: `src/drafts.ts`, `test/drafts.test.ts`
- Modify: `src/types.ts` (`PRComment`, `RenderMessage`)
- Modify: `src/GitHubClient.ts` (`mapComment`, line 88)
- Modify: `src/ReviewPanel.ts` (field at line 46; `render` lines 96-112; `_loadAndRender` lines 146-164; `addToDraft` and `submitReview` lines 235-260)
- Modify: `webview/draft.ts` (constructor)
- Modify: `webview/main.ts` (`DraftManager` construction, line 364)
- Modify: `package.json` (`scripts.test`)

**Interfaces:**
- Produces, `src/drafts.ts`:
  - `interface DraftComment { path: string; line: number; body: string }`. `line` is 0-based, as the webview sends it.
  - `prepareDraftComments(drafts: DraftComment[], snap: (path: string, line: number) => number, snapSuffix: (rawLine: number) => string): Array<{ path: string; line: number; body: string }>`
- Produces: `RenderMessage.draftCount: number`, `PRComment.path?: string`, and `new DraftManager(vscode, header, initialCount)`.

- [ ] **Step 1: Write the failing test**

Create `test/drafts.test.ts`:

```ts
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
```

Append ` && npx tsx test/drafts.test.ts` to `scripts.test`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx test/drafts.test.ts`
Expected: FAIL with `Cannot find module '../src/drafts'`.

- [ ] **Step 3: Implement `src/drafts.ts`**

```ts
export interface DraftComment {
  path: string;
  line: number; // 0-based, as sent by the webview
  body: string;
}

// Each draft keeps the file it was written on, so a review can span files.
export function prepareDraftComments(
  drafts: DraftComment[],
  snap: (path: string, line: number) => number,
  snapSuffix: (rawLine: number) => string
): Array<{ path: string; line: number; body: string }> {
  return drafts.map(d => {
    const rawLine = d.line + 1;
    const line = snap(d.path, rawLine);
    return { path: d.path, line, body: line !== rawLine ? `${d.body}${snapSuffix(rawLine)}` : d.body };
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx test/drafts.test.ts`
Expected: `All drafts tests passed ✓`

- [ ] **Step 5: Carry the path and draft count in the types**

In `src/types.ts`, add `path?: string;` to `PRComment` after `in_reply_to_id?: number;`. Add `draftCount: number;` to `RenderMessage` after `currentUserLogin: string;`.

In `src/GitHubClient.ts` `mapComment`, add `path: raw.path,` after `in_reply_to_id: raw.in_reply_to_id,`.

- [ ] **Step 6: Keep drafts per file in `src/ReviewPanel.ts`**

Add to the imports:

```ts
import { prepareDraftComments, type DraftComment } from './drafts';
```

Replace `private _draftComments: Array<{ line: number; body: string }> = [];` with:

```ts
  private _draftComments: DraftComment[] = [];
```

In `render()`, add these two fields to the `_lastRenderMsg` literal after `currentUserLogin: ctx.currentUserLogin,` (this also fixes the missing `validLines`):

```ts
      validLines: ctx.validLinesByPath.get(ctx.filePath) ?? [],
      draftCount: 0,
```

In `_loadAndRender`, delete the line `this._draftComments = [];`, and add `draftCount: this._draftComments.length,` after `currentUserLogin: this._currentUserLogin,` in its `_lastRenderMsg` literal.

Replace the `addToDraft` branch:

```ts
      } else if (msg.type === 'addToDraft') {
        this._draftComments.push({ line: msg.line, body: msg.body });
```

with:

```ts
      } else if (msg.type === 'addToDraft') {
        this._draftComments.push({ path: this._filePath, line: msg.line, body: msg.body });
        this._syncDraftCount();
```

Replace the whole `submitReview` branch (from `} else if (msg.type === 'submitReview') {` to its `postMessage({ type: 'reviewSubmitted', … })` line) with:

```ts
      } else if (msg.type === 'submitReview') {
        const preparedComments = prepareDraftComments(
          this._draftComments,
          (filePath, line) => this._snapToDiffLine(filePath, line),
          rawLine => this._snapSuffix(rawLine)
        );
        const comments = await submitDraftReview(
          this._owner, this._repo, this._prNumber, token,
          { commitId: this._headSha, comments: preparedComments }
        );
        this._draftComments = [];
        this._syncDraftCount();
        // A review can span files; only this file's comments belong in the open view.
        const forThisFile = comments.filter(c => c.path === this._filePath);
        this._updateCachedComments(cs => [...cs, ...forThisFile]);
        // Strip metadata so webview places bubbles at original lines
        const displayComments = forThisFile.map(c => {
          const { cleanBody, originalLine } = this._stripSnapSuffix(c.body);
          return originalLine ? { ...c, body: cleanBody, line: originalLine } : c;
        });
        this._panel.webview.postMessage({ type: 'reviewSubmitted', comments: displayComments });
```

Add this method after `_updateCachedComments`:

```ts
  // The cached render is re-sent when the panel is shown again; keep its badge count true.
  private _syncDraftCount(): void {
    if (this._lastRenderMsg) {
      this._lastRenderMsg = { ...this._lastRenderMsg, draftCount: this._draftComments.length };
    }
  }
```

- [ ] **Step 7: Restore the badge in the webview**

In `webview/draft.ts`, replace the constructor with:

```ts
  constructor(vscode: { postMessage(msg: unknown): void }, header: HTMLElement, initialCount = 0) {
    this._vscode = vscode;
    this._header = header;
    this._count = initialCount;
    if (initialCount > 0) this._render();
  }
```

In `webview/main.ts` `handleRender`, replace `draft = new DraftManager(vscode, header);` with:

```ts
  draft = new DraftManager(vscode, header, msg.draftCount ?? 0);
```

- [ ] **Step 8: Build, test, type-check**

```bash
npm test && npm run compile
npx tsc -p tsconfig.json --noEmit > ../tsc-now-ext.txt 2>&1; diff ../tsc-baseline-ext.txt ../tsc-now-ext.txt
```
Expected: seven `passed ✓` lines and `Build complete.`. The diff shows no added error lines. Removed lines are fine, since the `validLines` error should go.

- [ ] **Step 9: Manual check (human)**

Reload the dev host and open the panel on `index.md`. Select text, then "+ Add comment" → **Add to review**. Expected: the badge reads "1 pending comment". Switch to `other.md` with the file dropdown. Expected: the badge still reads 1. Add a draft there; the badge reads 2. Click into another editor tab so the panel is hidden, then come back. Expected: the badge reads 2. Click **Submit review (2)**. Expected: on GitHub, the PR's review has one comment on each file, on the right lines, and the bubble appears on `other.md` only.

- [ ] **Step 10: Commit**

```bash
git add src/drafts.ts test/drafts.test.ts src/types.ts src/GitHubClient.ts src/ReviewPanel.ts webview/draft.ts webview/main.ts package.json
git commit -m "fix: keep draft comments per file across file switches and panel re-shows"
```

---

### Task 4: Links to other files and external links

**Files:**
- Create: `src/links.ts`, `test/links-host.test.ts`
- Modify: `src/types.ts` (`RenderMessage`, `WebviewMessage`, `ExtensionMessage`)
- Modify: `src/ReviewPanel.ts` (imports; `render`; `_loadAndRender`; `_handleMessage`; new methods)
- Modify: `webview/main.ts` (state, message handlers, click handler, file dropdown, `initSelectionHandlers` call)
- Modify: `webview/overlay.ts` (`initSelectionHandlers`, line 225)
- Modify: `package.json` (`scripts.test`)

**Interfaces:**
- Consumes: `classifyHref`, `revealFragment` (Task 2), and `draftCount` (Task 3).
- Produces, `src/links.ts`:
  - `type ResolvedLink = { kind: 'external'; url: string } | { kind: 'file'; relPath: string; fragment?: string } | { kind: 'invalid'; reason: string }`
  - `resolveLink(currentFile: string, href: string): ResolvedLink`. `currentFile` is repo-relative with `/` separators.
  - `isMarkdownPath(p: string): boolean`
- Produces, messages: webview → host `{ type: 'openLink'; href: string; scrollTop: number }`. Host → webview `{ type: 'scrollTo'; fragment?: string; scrollTop?: number }` and `{ type: 'notice'; message: string }`. `RenderMessage.readOnly: boolean`.
- Produces, `ReviewPanel` private methods used by Task 5:
  - `_runNavigation(action: () => Promise<void>): Promise<void>`
  - `_show(target: { path: string; fragment?: string; scrollTop?: number }): Promise<boolean>`
  - `_openLink(href: string): Promise<void>`. Task 5 adds a `scrollTop` parameter.
  - `_notice(message: string): void`
  - `_loadAndRender(relPath: string): Promise<boolean>`
- Produces, webview: `let renderDone: Promise<void>`, the promise of the latest render.

- [ ] **Step 1: Write the failing test**

Create `test/links-host.test.ts`:

```ts
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
```

Append ` && npx tsx test/links-host.test.ts` to `scripts.test`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx test/links-host.test.ts`
Expected: FAIL with `Cannot find module '../src/links'`.

- [ ] **Step 3: Implement `src/links.ts`**

```ts
import * as path from 'path';

export type ResolvedLink =
  | { kind: 'external'; url: string }
  | { kind: 'file'; relPath: string; fragment?: string }
  | { kind: 'invalid'; reason: string };

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// Resolves a link found in `currentFile` (repo-relative, '/'-separated) the way GitHub does:
// relative to the file's folder, or to the repo root when it starts with '/'.
export function resolveLink(currentFile: string, href: string): ResolvedLink {
  if (SCHEME_RE.test(href)) {
    const scheme = href.slice(0, href.indexOf(':') + 1).toLowerCase();
    return EXTERNAL_SCHEMES.has(scheme)
      ? { kind: 'external', url: href }
      : { kind: 'invalid', reason: `Unsupported link: ${href}` };
  }

  const hashAt = href.indexOf('#');
  const beforeHash = hashAt === -1 ? href : href.slice(0, hashAt);
  const fragment = hashAt === -1 || hashAt === href.length - 1 ? undefined : safeDecode(href.slice(hashAt + 1));
  const queryAt = beforeHash.indexOf('?');
  const linkPath = safeDecode(queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt));

  if (linkPath === '') return { kind: 'file', relPath: currentFile, fragment };

  const joined = linkPath.startsWith('/')
    ? linkPath.slice(1)
    : path.posix.join(path.posix.dirname(currentFile), linkPath);
  const relPath = path.posix.normalize(joined);
  if (relPath === '..' || relPath.startsWith('../') || path.posix.isAbsolute(relPath)) {
    return { kind: 'invalid', reason: `Link leaves the repository: ${href}` };
  }
  return { kind: 'file', relPath, fragment };
}

export function isMarkdownPath(p: string): boolean {
  return /\.(md|markdown)$/i.test(p);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx test/links-host.test.ts`
Expected: `All links-host tests passed ✓`

- [ ] **Step 5: Add the message types**

In `src/types.ts`:
- Add `readOnly: boolean; // a linked file that is not part of the PR` to `RenderMessage` after `draftCount: number;`.
- Add to `WebviewMessage`: `| { type: 'openLink'; href: string; scrollTop: number }`.
- Add to `ExtensionMessage`: `| { type: 'scrollTo'; fragment?: string; scrollTop?: number }` and `| { type: 'notice'; message: string }`.

- [ ] **Step 6: Open links in the host (`src/ReviewPanel.ts`)**

Add to the imports:

```ts
import { resolveLink, isMarkdownPath } from './links';
```

Add a field after `_lastRenderMsg`:

```ts
  private _navigating = false;
```

In `render()`, add `readOnly: false,` after `draftCount: 0,`.

In `_loadAndRender`:
- Change the signature to `private async _loadAndRender(relPath: string): Promise<boolean> {`.
- In the `catch` block, after the `postError` line, add `return false;`, replacing the bare `return;`.
- Add `readOnly: !this._prFiles.some(f => f.path === relPath),` after `draftCount: this._draftComments.length,`.
- Add `return true;` as the last line, after the `postMessage(this._lastRenderMsg)`.

In `_handleMessage`, add this directly after the `switchFile` branch:

```ts
    if (msg.type === 'openLink') {
      await this._runNavigation(() => this._openLink(msg.href));
      return;
    }
```

Add these methods after `_loadAndRender`:

```ts
  // One navigation at a time; failures (unreadable file, GitHub fetch error) become a toast.
  private async _runNavigation(action: () => Promise<void>): Promise<void> {
    if (this._navigating) return;
    this._navigating = true;
    try {
      await action();
    } catch (err: unknown) {
      this._notice(err instanceof Error ? err.message : String(err));
    } finally {
      this._navigating = false;
    }
  }

  private _notice(message: string): void {
    this._panel.webview.postMessage({ type: 'notice', message });
  }

  private async _openLink(href: string): Promise<void> {
    const link = resolveLink(this._filePath, href);
    if (link.kind === 'invalid') {
      this._notice(link.reason);
      return;
    }
    if (link.kind === 'external') {
      await vscode.env.openExternal(vscode.Uri.parse(link.url));
      return;
    }
    const absPath = path.join(this._repoRoot, link.relPath);
    if (!fs.existsSync(absPath)) {
      this._notice(`File not found: ${link.relPath}`);
      return;
    }
    if (!isMarkdownPath(link.relPath)) {
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(absPath), {
        viewColumn: vscode.ViewColumn.One,
        preview: true,
      });
      return;
    }
    await this._show({ path: link.relPath, fragment: link.fragment });
  }

  // Shows a location: loads the file if it is not the current one, then asks the webview to
  // scroll. Returns false when the file could not be loaded.
  private async _show(target: { path: string; fragment?: string; scrollTop?: number }): Promise<boolean> {
    if (target.path !== this._filePath && !(await this._loadAndRender(target.path))) return false;
    this._panel.webview.postMessage(
      target.fragment
        ? { type: 'scrollTo', fragment: target.fragment }
        : { type: 'scrollTo', scrollTop: target.scrollTop ?? 0 }
    );
    return true;
  }
```

- [ ] **Step 7: Make files outside the PR read-only (`webview/overlay.ts`)**

Replace the `initSelectionHandlers` signature:

```ts
export function initSelectionHandlers(
  container: HTMLElement,
  onAddComment: (anchor: HTMLElement, line: number) => void,
  getValidLines: () => number[] = () => []
): void {
```

with:

```ts
export function initSelectionHandlers(
  container: HTMLElement,
  onAddComment: (anchor: HTMLElement, line: number) => void,
  getValidLines: () => number[] = () => [],
  isReadOnly: () => boolean = () => false
): void {
```

In the `mouseup` listener, add `if (isReadOnly()) return;` directly after `removeFloatBtn();`. In the `contextmenu` listener, add `if (isReadOnly()) return;` directly after `removeContextMenu();`. The native menu then shows instead.

- [ ] **Step 8: Wire the webview (`webview/main.ts`)**

Add module state after `let currentMarkdown = '';`:

```ts
let readOnly = false;
let renderDone: Promise<void> = Promise.resolve();
```

In the `message` listener, replace:

```ts
  if (msg.type === 'render') {
    handleRender(msg).catch(console.error);
    return;
  }

  if (!contentEl) return;
```

with:

```ts
  if (msg.type === 'render') {
    renderDone = handleRender(msg).catch(console.error);
    return;
  }

  if (msg.type === 'scrollTo') {
    // The render before this message may still be laying out mermaid diagrams.
    void renderDone.then(() => {
      if (msg.fragment) revealFragment(msg.fragment);
      else window.scrollTo(0, msg.scrollTop ?? 0);
    });
    return;
  }

  if (msg.type === 'notice') {
    showToast(msg.message);
    return;
  }

  if (!contentEl) return;
```

Replace the click handler added in Task 2 with:

```ts
// VS Code webviews block link navigation, so every link is routed here.
document.addEventListener('click', (e) => {
  const a = (e.target as Element).closest('a');
  if (!a) return;
  const action = classifyHref(a.getAttribute('href'));
  if (action.kind === 'ignore') return;
  e.preventDefault();
  if (action.kind === 'fragment') revealFragment(action.id);
  else vscode.postMessage({ type: 'openLink', href: action.href, scrollTop: window.scrollY });
});
```

In `handleRender`, add `readOnly = msg.readOnly ?? false;` after `validLines = msg.validLines ?? [];`. After the `for (const f of msg.prFiles) { … }` loop that fills the dropdown, add:

```ts
  if (!msg.prFiles.some(f => f.path === msg.filePath)) {
    // A linked file outside the PR: show it in the switcher, marked read-only.
    const opt = document.createElement('option');
    opt.value = msg.filePath;
    opt.dataset.shortLabel = `${fileShortName(msg.filePath, [...allPaths, msg.filePath])} (not in PR)`;
    opt.dataset.fullLabel = `${msg.filePath} (not in PR)`;
    opt.textContent = opt.dataset.shortLabel;
    opt.selected = true;
    opt.disabled = true;
    selectEl.appendChild(opt);
  }
```

Replace `initSelectionHandlers(contentEl, onAddComment, () => validLines);` with:

```ts
    initSelectionHandlers(contentEl, onAddComment, () => validLines, () => readOnly);
```

- [ ] **Step 9: Build, test, type-check**

```bash
npm test && npm run compile
npx tsc -p tsconfig.json --noEmit > ../tsc-now-ext.txt 2>&1; diff ../tsc-baseline-ext.txt ../tsc-now-ext.txt
npx tsc -p tsconfig.webview.json --noEmit > ../tsc-now-webview.txt 2>&1; diff ../tsc-baseline-webview.txt ../tsc-now-webview.txt
```
Expected: eight `passed ✓` lines and `Build complete.`. Neither diff shows added error lines.

- [ ] **Step 10: Manual check (human)**

Reload the dev host and open the panel on `index.md`. Then:
- "Scenario S2 in the other file": expected, `other.md` loads scrolled to S2, and the S2 heading shows no literal `<a id>` text.
- From `other.md`, "See Q1 in index.md": `index.md` loads at the Q1 row.
- "The other file, top": `other.md` loads at the top.
- "The repository README": `README.md` loads, and the dropdown shows "README.md (not in PR)". Selecting text there shows no "+ Add comment", and right-click shows the normal menu.
- "A file that is not markdown": `package.json` opens in an editor tab.
- "A link that leaves the repository": the toast reads "Link leaves the repository: …".
- "GitHub": opens in the browser.
- Click two links quickly in a row: one navigation happens and nothing errors.

- [ ] **Step 11: Commit and push**

```bash
git add src/links.ts test/links-host.test.ts src/types.ts src/ReviewPanel.ts webview/main.ts webview/overlay.ts package.json
git commit -m "feat: follow links to other files, open external links, show linked non-PR files read-only"
git push
```

- [ ] **Step 12: Checkpoint: offer the fixes upstream (only with Pat's go-ahead)**

`fix/link-navigation` now holds only fixes plus fixtures. Opening a PR against `FrankLedo/markdown-pr-review` is outward-facing, so ask before running:

```bash
gh pr create --repo FrankLedo/markdown-pr-review --base main --head "$(gh api user -q .login):fix/link-navigation" --title "Fix link navigation: digit-leading fragments, <a id> anchors, cross-file links, drafts across files" --body "Fixes three link defects and one draft defect. (1) Fragment links used querySelector, which throws for heading slugs that start with a digit; now getElementById. (2) html:false escaped empty <a id>/<a name> anchors; a narrow inline rule now renders exactly that shape. (3) Relative links to other files went nowhere; the host now resolves them, loads markdown in the panel (read-only when outside the PR), opens other files in an editor and http/mailto externally. (4) Draft comments were cleared on file switch and the badge vanished on panel re-show; drafts now keep their file. Unit tests added for each pure part; manual-test fixtures in test/fixtures/navigation. Plan: docs/superpowers/plans/2026-10-07-link-navigation-history-outline.md"
```

---

### Task 5: Back and forward navigation

**Files:**
- Create: `src/history.ts`, `test/history.test.ts`, `webview/history-controls.ts`
- Modify: `src/types.ts`, `src/ReviewPanel.ts`, `src/extension.ts`, `webview/main.ts`, `package.json`

**Interfaces:**
- Consumes: `_runNavigation`, `_show`, `_openLink`, `_notice` (Task 4); `findFragmentTarget` and `revealFragment` (Task 2).
- Produces, `src/history.ts`:
  - `interface HistoryLocation { path: string; scrollTop: number }`
  - `class NavHistory { constructor(limit?: number); canGoBack: boolean; canGoForward: boolean; push(current); peekBack(); peekForward(); commitBack(current); commitForward(current) }`
- Produces, messages: webview → host `{ type: 'historyPush'; scrollTop: number }` and `{ type: 'navigate'; direction: 'back' | 'forward'; scrollTop: number }`, and `switchFile` gains `scrollTop: number`. Host → webview `{ type: 'historyState'; canGoBack: boolean; canGoForward: boolean }` and `{ type: 'requestNavigate'; direction: 'back' | 'forward' }`.
- Produces, `ReviewPanel.requestNavigate(direction: 'back' | 'forward'): void` (public).
- Produces, `webview/history-controls.ts`: `mountHistoryControls(group: HTMLElement, onBack: () => void, onForward: () => void): { setState(canGoBack: boolean, canGoForward: boolean): void }`.
- Produces, webview: `const headerLeft: HTMLElement` (the `.pr-header-left` group) and `jumpToFragment(id: string): void`, which records history and then reveals. Task 6 uses both.

- [ ] **Step 1: Branch and open a test PR**

```bash
git switch -c feat/navigation
git push -u origin feat/navigation
gh pr create --repo "$(gh repo view --json nameWithOwner -q .nameWithOwner)" --base main --head feat/navigation --draft --title "Navigation history and outline" --body "Test PR for history and outline. Not for merge."
```

- [ ] **Step 2: Write the failing test**

Create `test/history.test.ts`:

```ts
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
```

Append ` && npx tsx test/history.test.ts` to `scripts.test`.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx tsx test/history.test.ts`
Expected: FAIL with `Cannot find module '../src/history'`.

- [ ] **Step 4: Implement `src/history.ts`**

```ts
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
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx tsx test/history.test.ts`
Expected: `All history tests passed ✓`

- [ ] **Step 6: Message types**

In `src/types.ts`:
- Change `| { type: 'switchFile'; path: string }` to `| { type: 'switchFile'; path: string; scrollTop: number }`.
- Add to `WebviewMessage`: `| { type: 'historyPush'; scrollTop: number }` and `| { type: 'navigate'; direction: 'back' | 'forward'; scrollTop: number }`.
- Add to `ExtensionMessage`: `| { type: 'historyState'; canGoBack: boolean; canGoForward: boolean }` and `| { type: 'requestNavigate'; direction: 'back' | 'forward' }`.

- [ ] **Step 7: History in the host (`src/ReviewPanel.ts`)**

Add to the imports:

```ts
import { NavHistory, type HistoryLocation } from './history';
```

Add a field after `_navigating`:

```ts
  private _history = new NavHistory();
```

In `render()`, add `this._history = new NavHistory();` before `this._panel.title = …`, and `this._postHistoryState();` after its `postMessage(this._lastRenderMsg)`.

In the `ready` branch of `_handleMessage`, add `this._postHistoryState();` after the inner `if` block.

Replace the `switchFile` and `openLink` branches with:

```ts
    if (msg.type === 'switchFile') {
      await this._runNavigation(() => this._navigateTo({ path: msg.path }, msg.scrollTop));
      return;
    }

    if (msg.type === 'openLink') {
      await this._runNavigation(() => this._openLink(msg.href, msg.scrollTop));
      return;
    }

    if (msg.type === 'historyPush') {
      this._history.push({ path: this._filePath, scrollTop: msg.scrollTop });
      this._postHistoryState();
      return;
    }

    if (msg.type === 'navigate') {
      await this._runNavigation(() => this._go(msg.direction, msg.scrollTop));
      return;
    }
```

In `_openLink`, change the signature to `private async _openLink(href: string, scrollTop: number): Promise<void> {`. Replace its last line, `await this._show({ path: link.relPath, fragment: link.fragment });`, with:

```ts
    await this._navigateTo({ path: link.relPath, fragment: link.fragment }, scrollTop);
```

Add these methods after `_show`:

```ts
  // A new navigation: show the target, then record the location being left.
  private async _navigateTo(target: { path: string; fragment?: string }, fromScrollTop: number): Promise<void> {
    const here: HistoryLocation = { path: this._filePath, scrollTop: fromScrollTop };
    if (await this._show(target)) {
      this._history.push(here);
      this._postHistoryState();
    }
  }

  private async _go(direction: 'back' | 'forward', fromScrollTop: number): Promise<void> {
    const target = direction === 'back' ? this._history.peekBack() : this._history.peekForward();
    if (!target) return;
    const here: HistoryLocation = { path: this._filePath, scrollTop: fromScrollTop };
    if (!(await this._show(target))) return;
    if (direction === 'back') this._history.commitBack(here);
    else this._history.commitForward(here);
    this._postHistoryState();
  }

  private _postHistoryState(): void {
    this._panel.webview.postMessage({
      type: 'historyState',
      canGoBack: this._history.canGoBack,
      canGoForward: this._history.canGoForward,
    });
  }

  // For the back/forward commands: the webview replies with a 'navigate' carrying its scroll position.
  requestNavigate(direction: 'back' | 'forward'): void {
    this._panel.webview.postMessage({ type: 'requestNavigate', direction });
  }
```

Add to the `_buildHtml` CSS, after the `.pr-nav-btn:hover` rule:

```css
    .pr-nav-btn:disabled { opacity: 0.4; cursor: default; }
    .pr-header-left { order: -1; display: flex; align-items: center; gap: 4px; margin-right: auto; }
```

- [ ] **Step 8: Back/forward buttons (`webview/history-controls.ts`)**

```ts
export interface HistoryControls {
  setState(canGoBack: boolean, canGoForward: boolean): void;
}

export function mountHistoryControls(
  group: HTMLElement,
  onBack: () => void,
  onForward: () => void
): HistoryControls {
  const back = makeButton('←', 'Back', onBack);
  const forward = makeButton('→', 'Forward', onForward);
  group.append(back, forward);

  const setState = (canGoBack: boolean, canGoForward: boolean): void => {
    back.disabled = !canGoBack;
    forward.disabled = !canGoForward;
  };
  setState(false, false);
  return { setState };
}

function makeButton(text: string, tooltip: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = 'pr-nav-btn';
  button.textContent = text;
  button.dataset.tooltip = tooltip;
  button.setAttribute('aria-label', tooltip);
  button.addEventListener('click', onClick);
  return button;
}
```

- [ ] **Step 9: Wire the webview (`webview/main.ts`)**

Add to the imports:

```ts
import { mountHistoryControls } from './history-controls';
```

After `const vscode = acquireVsCodeApi();`, add:

```ts
// Left-hand header group: history buttons (and, later, the outline toggle).
const headerLeft = document.createElement('span');
headerLeft.className = 'pr-header-left';
document.getElementById('review-header')!.prepend(headerLeft);
const historyControls = mountHistoryControls(headerLeft, () => navigate('back'), () => navigate('forward'));

function navigate(direction: 'back' | 'forward'): void {
  vscode.postMessage({ type: 'navigate', direction, scrollTop: window.scrollY });
}
```

After `revealFragment`, add:

```ts
// A jump the reader makes within this file: record where they were, then move.
function jumpToFragment(id: string): void {
  if (findFragmentTarget(id)) vscode.postMessage({ type: 'historyPush', scrollTop: window.scrollY });
  revealFragment(id);
}
```

In the click handler, replace `if (action.kind === 'fragment') revealFragment(action.id);` with `if (action.kind === 'fragment') jumpToFragment(action.id);`. The `scrollTo` handler keeps calling `revealFragment`, because the host has already recorded that navigation.

In the `message` listener, add these after the `notice` branch:

```ts
  if (msg.type === 'historyState') {
    historyControls.setState(msg.canGoBack, msg.canGoForward);
    return;
  }

  if (msg.type === 'requestNavigate') {
    navigate(msg.direction);
    return;
  }
```

In `handleRender`, replace `vscode.postMessage({ type: 'switchFile', path: selectEl!.value });` with:

```ts
      vscode.postMessage({ type: 'switchFile', path: selectEl!.value, scrollTop: window.scrollY });
```

After the click handler, add:

```ts
// Mouse back/forward buttons, where the platform delivers them to the webview.
document.addEventListener('mouseup', (e) => {
  if (e.button === 3) { e.preventDefault(); navigate('back'); }
  if (e.button === 4) { e.preventDefault(); navigate('forward'); }
});
```

- [ ] **Step 10: Commands and keybindings**

In `src/extension.ts`, add this before `context.subscriptions.push(command);`:

```ts
  context.subscriptions.push(
    vscode.commands.registerCommand('markdown-pr-review.navigateBack', () =>
      ReviewPanel.currentPanel?.requestNavigate('back')),
    vscode.commands.registerCommand('markdown-pr-review.navigateForward', () =>
      ReviewPanel.currentPanel?.requestNavigate('forward')),
  );
```

In `package.json`, replace the whole `"contributes"` object with:

```json
  "contributes": {
    "commands": [
      {
        "command": "markdown-pr-review.openReview",
        "title": "Markdown PR Review: Open Review Panel",
        "icon": "$(comment-discussion)"
      },
      {
        "command": "markdown-pr-review.navigateBack",
        "title": "Markdown PR Review: Go Back"
      },
      {
        "command": "markdown-pr-review.navigateForward",
        "title": "Markdown PR Review: Go Forward"
      }
    ],
    "keybindings": [
      {
        "command": "markdown-pr-review.navigateBack",
        "key": "alt+left",
        "mac": "ctrl+-",
        "when": "activeWebviewPanelId == 'markdownPrReview'"
      },
      {
        "command": "markdown-pr-review.navigateForward",
        "key": "alt+right",
        "mac": "ctrl+shift+-",
        "when": "activeWebviewPanelId == 'markdownPrReview'"
      }
    ],
    "menus": {
      "editor/context": [
        {
          "command": "markdown-pr-review.openReview",
          "when": "editorLangId == markdown",
          "group": "navigation"
        }
      ],
      "commandPalette": [
        {
          "command": "markdown-pr-review.navigateBack",
          "when": "activeWebviewPanelId == 'markdownPrReview'"
        },
        {
          "command": "markdown-pr-review.navigateForward",
          "when": "activeWebviewPanelId == 'markdownPrReview'"
        }
      ]
    }
  },
```

- [ ] **Step 11: Build, test, type-check**

```bash
npm test && npm run compile
npx tsc -p tsconfig.json --noEmit > ../tsc-now-ext.txt 2>&1; diff ../tsc-baseline-ext.txt ../tsc-now-ext.txt
npx tsc -p tsconfig.webview.json --noEmit > ../tsc-now-webview.txt 2>&1; diff ../tsc-baseline-webview.txt ../tsc-now-webview.txt
```
Expected: nine `passed ✓` lines and `Build complete.`. No added type errors.

- [ ] **Step 12: Manual check (human)**

Restart the dev host (stop, then F5), because `package.json` changed. On `index.md`:
1. ← and → are disabled.
2. Scroll halfway down "1. Overview", scroll back to Contents, click "5.5 Composing". Then press ←. Expected: back at Contents.
3. Press →. Expected: back at 5.5.
4. Click "Scenario S2 in the other file". Then ←. Expected: `index.md` at Contents.
5. Press →. Expected: `other.md` at S2.
6. Use the keyboard shortcut (Ctrl+- on macOS, Alt+← elsewhere) while the panel has focus. Expected: same as ←, and VS Code's own editor-history navigation does not also fire.
7. Pick another file from the dropdown, then ←. Expected: back to the previous file and scroll position.
8. Hide the panel tab and show it again. Expected: the buttons' enabled state is unchanged.
9. If you have a mouse with side buttons, try them. Record whether they work. Not working is a known possibility, not a failure.

- [ ] **Step 13: Commit**

```bash
git add src/history.ts test/history.test.ts webview/history-controls.ts src/types.ts src/ReviewPanel.ts src/extension.ts webview/main.ts package.json
git commit -m "feat: back/forward navigation across in-file jumps, links and file switches"
```

---

### Task 6: Outline panel

**Files:**
- Create: `webview/outline-model.ts`, `test/outline-model.test.ts`, `webview/outline.ts`
- Modify: `webview/main.ts`, `src/ReviewPanel.ts` (CSS), `package.json` (`scripts.test`)

**Interfaces:**
- Consumes: `headerLeft` and `jumpToFragment` (Task 5); heading `id` and `data-line` attributes (renderer).
- Produces, `webview/outline-model.ts`:
  - `interface HeadingInfo { level: number; id: string; text: string; line: number }`. `line` is the 0-based `data-line`.
  - `interface OutlineItem extends HeadingInfo { openThreads: number }`
  - `visibleOutline(items: OutlineItem[], maxDepth: number, query: string): OutlineItem[]`
  - `countOpenThreadsBySection(headings: HeadingInfo[], openThreadLines: number[]): number[]`. `openThreadLines` are 0-based. A section runs to the next heading of the same or higher level, so counts roll up.
  - `activeHeadingIndex(tops: number[], scrollTop: number, offset: number): number`
- Produces, `webview/outline.ts`: `interface OutlineState { open: boolean; maxDepth: number }` and `class OutlinePanel { constructor(onJump, initial, onStateChange); toggle(); setItems(items); setActive(id); layout() }`.

- [ ] **Step 1: Write the failing test**

Create `test/outline-model.test.ts`:

```ts
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
```

Append ` && npx tsx test/outline-model.test.ts` to `scripts.test`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx test/outline-model.test.ts`
Expected: FAIL with `Cannot find module '../webview/outline-model'`.

- [ ] **Step 3: Implement `webview/outline-model.ts`**

```ts
export interface HeadingInfo {
  level: number;
  id: string;
  text: string;
  line: number; // 0-based source line (data-line)
}

export interface OutlineItem extends HeadingInfo {
  openThreads: number;
}

// A filter query searches every level; otherwise the depth setting applies.
export function visibleOutline(items: OutlineItem[], maxDepth: number, query: string): OutlineItem[] {
  const q = query.trim().toLowerCase();
  if (q) return items.filter(item => item.text.toLowerCase().includes(q));
  return items.filter(item => item.level <= maxDepth);
}

// A section runs from its heading to the next heading of the same or higher level, so a
// heading's count includes its subsections.
export function countOpenThreadsBySection(headings: HeadingInfo[], openThreadLines: number[]): number[] {
  return headings.map((heading, i) => {
    let end = Infinity;
    for (let j = i + 1; j < headings.length; j++) {
      if (headings[j].level <= heading.level) {
        end = headings[j].line;
        break;
      }
    }
    return openThreadLines.filter(line => line >= heading.line && line < end).length;
  });
}

// `tops` are ascending document offsets of the headings.
export function activeHeadingIndex(tops: number[], scrollTop: number, offset: number): number {
  let active = -1;
  for (let i = 0; i < tops.length; i++) {
    if (tops[i] <= scrollTop + offset) active = i;
    else break;
  }
  return active;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx test/outline-model.test.ts`
Expected: `All outline-model tests passed ✓`

- [ ] **Step 5: Implement `webview/outline.ts`**

```ts
import { visibleOutline, type OutlineItem } from './outline-model';

export interface OutlineState {
  open: boolean;
  maxDepth: number;
}

const DEPTHS: Array<[number, string]> = [[2, 'H2'], [3, 'H3'], [4, 'H4'], [6, 'All']];

export class OutlinePanel {
  private readonly _onJump: (id: string) => void;
  private readonly _onStateChange: (state: OutlineState) => void;
  private readonly _state: OutlineState;
  private readonly _root: HTMLElement;
  private readonly _filter: HTMLInputElement;
  private readonly _list: HTMLUListElement;
  private readonly _depthButtons: HTMLButtonElement[] = [];
  private _items: OutlineItem[] = [];
  private _activeId: string | null = null;

  constructor(
    onJump: (id: string) => void,
    initial: OutlineState,
    onStateChange: (state: OutlineState) => void
  ) {
    this._onJump = onJump;
    this._onStateChange = onStateChange;
    this._state = { ...initial };

    this._root = document.createElement('nav');
    this._root.className = 'pr-outline';
    this._root.setAttribute('aria-label', 'Document outline');

    const tools = document.createElement('div');
    tools.className = 'pr-outline-tools';

    this._filter = document.createElement('input');
    this._filter.type = 'search';
    this._filter.placeholder = 'Filter headings';
    this._filter.className = 'pr-outline-filter';
    this._filter.addEventListener('input', () => this._renderList());
    this._filter.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this._filter.value = '';
        this._renderList();
      }
    });

    const depthRow = document.createElement('div');
    depthRow.className = 'pr-outline-depth';
    for (const [depth, label] of DEPTHS) {
      const button = document.createElement('button');
      button.className = 'pr-nav-btn';
      button.textContent = label;
      button.dataset.depth = String(depth);
      button.addEventListener('click', () => {
        this._state.maxDepth = depth;
        this._emit();
        this._renderList();
      });
      depthRow.appendChild(button);
      this._depthButtons.push(button);
    }

    tools.append(this._filter, depthRow);

    this._list = document.createElement('ul');
    this._list.className = 'pr-outline-list';
    this._list.addEventListener('click', (e) => {
      const item = (e.target as Element).closest<HTMLElement>('[data-heading-id]');
      if (item?.dataset.headingId) this._onJump(item.dataset.headingId);
    });

    this._root.append(tools, this._list);
    document.body.appendChild(this._root);
    this.layout();
  }

  toggle(): void {
    this._state.open = !this._state.open;
    this._emit();
    this.layout();
    if (this._state.open) this._filter.focus();
  }

  setItems(items: OutlineItem[]): void {
    this._items = items;
    this._renderList();
  }

  setActive(id: string | null): void {
    if (id === this._activeId) return;
    this._activeId = id;
    this._list.querySelectorAll('.pr-outline-active').forEach(el => el.classList.remove('pr-outline-active'));
    if (!id) return;
    const item = this._list.querySelector<HTMLElement>(`[data-heading-id="${CSS.escape(id)}"]`);
    item?.classList.add('pr-outline-active');
    if (this._state.open) item?.scrollIntoView({ block: 'nearest' });
  }

  // Applies the open state and sits the panel under the sticky header, whose height varies.
  layout(): void {
    document.body.classList.toggle('pr-outline-open', this._state.open);
    const header = document.getElementById('review-header');
    this._root.style.top = `${header?.getBoundingClientRect().bottom ?? 0}px`;
  }

  private _renderList(): void {
    const items = visibleOutline(this._items, this._state.maxDepth, this._filter.value);
    this._list.replaceChildren(...items.map(item => {
      const li = document.createElement('li');
      li.className = `pr-outline-item pr-outline-h${item.level}`;
      li.dataset.headingId = item.id;
      li.title = item.text;
      if (item.id === this._activeId) li.classList.add('pr-outline-active');

      const label = document.createElement('span');
      label.className = 'pr-outline-label';
      label.textContent = item.text;
      li.appendChild(label);

      if (item.openThreads > 0) {
        const count = document.createElement('span');
        count.className = 'pr-outline-count';
        count.textContent = String(item.openThreads);
        count.title = `${item.openThreads} open thread${item.openThreads > 1 ? 's' : ''}`;
        li.appendChild(count);
      }
      return li;
    }));
    this._depthButtons.forEach(b =>
      b.classList.toggle('pr-outline-depth--on', Number(b.dataset.depth) === this._state.maxDepth));
  }

  private _emit(): void {
    this._onStateChange({ ...this._state });
  }
}
```

- [ ] **Step 6: Wire the outline (`webview/main.ts`)**

Add to the imports:

```ts
import { OutlinePanel, type OutlineState } from './outline';
import { countOpenThreadsBySection, activeHeadingIndex, type HeadingInfo } from './outline-model';
```

Replace the `acquireVsCodeApi` declaration with:

```ts
declare const acquireVsCodeApi: () => {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};
```

After the `navigate` function (Task 5), add:

```ts
interface WebviewState { outline?: OutlineState }
const savedState = (vscode.getState() as WebviewState | undefined) ?? {};
const outline = new OutlinePanel(
  id => jumpToFragment(id),
  savedState.outline ?? { open: false, maxDepth: 3 },
  state => vscode.setState({ ...savedState, outline: state })
);

const outlineButton = document.createElement('button');
outlineButton.className = 'pr-nav-btn';
outlineButton.textContent = '☰';
outlineButton.dataset.tooltip = 'Outline  o';
outlineButton.setAttribute('aria-label', 'Toggle outline');
outlineButton.addEventListener('click', () => outline.toggle());
headerLeft.prepend(outlineButton);

let headings: HeadingInfo[] = [];
let headingEls: HTMLElement[] = [];

// Read before overlays add bubbles to the headings. Headings inside <details> are skipped:
// their data-line counts from the start of the block, not the file.
function collectHeadings(container: HTMLElement): void {
  headingEls = Array.from(container.querySelectorAll<HTMLElement>('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]'))
    .filter(el => !el.closest('details'));
  headings = headingEls.map(el => ({
    level: Number(el.tagName.slice(1)),
    id: el.id,
    text: el.textContent?.trim() ?? '',
    line: Number(el.dataset.line ?? -1),
  }));
}

function refreshOutline(): void {
  const resolved = new Set(allThreadMeta.filter(t => t.isResolved).map(t => t.rootCommentId));
  const openLines = allComments
    .filter(c => !c.in_reply_to_id && !resolved.has(c.id))
    .map(c => c.line - 1);
  const counts = countOpenThreadsBySection(headings, openLines);
  outline.setItems(headings.map((heading, i) => ({ ...heading, openThreads: counts[i] })));
}

function updateActiveHeading(): void {
  const headerHeight = document.getElementById('review-header')!.offsetHeight;
  const tops = headingEls.map(el => el.getBoundingClientRect().top + window.scrollY);
  const i = activeHeadingIndex(tops, window.scrollY, headerHeight + 8);
  outline.setActive(i >= 0 ? headingEls[i].id : null);
}

let scrollFrame = 0;
window.addEventListener('scroll', () => {
  if (scrollFrame) return;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0;
    updateActiveHeading();
  });
}, { passive: true });
window.addEventListener('resize', () => outline.layout());
```

In the `keydown` listener, add this after the `]` line:

```ts
  if (e.key === 'o' && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); outline.toggle(); }
```

In `handleRender`, add `collectHeadings(contentEl);` directly after `contentEl.innerHTML = renderMarkdown(msg.markdown);`. Then after `navStrip.update(countThreads());`, add:

```ts
  refreshOutline();
  outline.layout();
  updateActiveHeading();
```

In `placeOverlaysKeepOpen`, add `refreshOutline();` after `navStrip?.refresh(countThreads());`.

- [ ] **Step 7: Outline CSS (`src/ReviewPanel.ts` `_buildHtml`)**

Add after the `.pr-header-left` rule from Task 5:

```css
    .pr-outline {
      position: fixed; left: 0; bottom: 0; width: 280px;
      display: none; flex-direction: column; z-index: 90; font-size: 12px;
      background: var(--vscode-sideBar-background, var(--vscode-editor-background));
      border-right: 1px solid var(--vscode-widget-border, rgba(255,255,255,0.1));
    }
    body.pr-outline-open .pr-outline { display: flex; }
    @media (min-width: 1160px) { body.pr-outline-open #content { margin-left: 300px; } }
    .pr-outline-tools {
      padding: 8px; display: flex; flex-direction: column; gap: 6px;
      border-bottom: 1px solid var(--vscode-widget-border, rgba(255,255,255,0.1));
    }
    .pr-outline-filter {
      width: 100%; box-sizing: border-box; padding: 3px 6px; font-size: 12px; border-radius: 3px;
      background: var(--vscode-input-background, transparent);
      color: var(--vscode-input-foreground, inherit);
      border: 1px solid var(--vscode-input-border, rgba(255,255,255,0.2));
    }
    .pr-outline-depth { display: flex; gap: 4px; }
    .pr-outline-depth--on { outline: 1px solid var(--vscode-focusBorder, #007acc); }
    .pr-outline-list { list-style: none; margin: 0; padding: 4px 0; overflow-y: auto; flex: 1; }
    .pr-outline-item { display: flex; align-items: center; gap: 6px; padding: 2px 8px; cursor: pointer; white-space: nowrap; }
    .pr-outline-item:hover { background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.05)); }
    .pr-outline-label { flex: 1; overflow: hidden; text-overflow: ellipsis; }
    .pr-outline-active { background: var(--vscode-list-inactiveSelectionBackground, rgba(255,255,255,0.1)); font-weight: 600; }
    .pr-outline-h3 { padding-left: 20px; }
    .pr-outline-h4 { padding-left: 32px; }
    .pr-outline-h5 { padding-left: 44px; }
    .pr-outline-h6 { padding-left: 56px; }
    .pr-outline-count {
      background: var(--vscode-badge-background, #4d4d4d); color: var(--vscode-badge-foreground, #fff);
      border-radius: 8px; padding: 0 6px; font-size: 10px;
    }
```

- [ ] **Step 8: Build, test, type-check**

```bash
npm test && npm run compile
npx tsc -p tsconfig.webview.json --noEmit > ../tsc-now-webview.txt 2>&1; diff ../tsc-baseline-webview.txt ../tsc-now-webview.txt
```
Expected: ten `passed ✓` lines and `Build complete.`. No added type errors.

- [ ] **Step 9: Manual check (human)**

Reload the dev host and open the panel on `index.md`. Then:
- Click ☰ (or press `o`). Expected: the outline opens on the left, under the header, with H1–H3 listed and H3 indented.
- Click H2, then All. Expected: the list changes with each depth.
- Type "envelope" in the filter. Expected: only "5.2 The envelope…" is listed, whatever the depth. Escape clears the filter.
- Click an entry. Expected: the document jumps there, and ← returns to where you were.
- Scroll through the document. Expected: the highlighted entry follows the section in view.
- Add a comment under 5.2. Expected: "5.2 …" and "5. Recommendation" each show 1. Resolve the thread. Expected: both counts disappear.
- Narrow the panel below about 1,160px. Expected: the outline overlays the text instead of pushing it.
- Hide the tab and show it again. Expected: the outline is still open, at the same depth.
- On `other.md`, the S1 and S2 entries read "S1 · First scenario", with no anchor markup.

- [ ] **Step 10: Commit and push**

```bash
git add webview/outline-model.ts webview/outline.ts test/outline-model.test.ts webview/main.ts src/ReviewPanel.ts package.json
git commit -m "feat: outline panel with depth, filter, active section and open-thread counts"
git push
```

---

### Task 7: Fork build and install

**Files:**
- Modify: `package.json` (`publisher`, `displayName`, `version`), on branch `fork-build` only

**Interfaces:**
- Consumes: everything above.
- Produces: `markdown-pr-review-1.7.0.vsix`, installed locally as `local.markdown-pr-review`.

- [ ] **Step 1: Branch and set the fork identity**

```bash
git switch -c fork-build
```

In `package.json`, set `"publisher": "local"`, `"displayName": "Markdown PR Review (fork)"` and `"version": "1.7.0"`. Leave `name` and the command ids unchanged.

- [ ] **Step 2: Package**

```bash
npm test && npx vsce package --no-dependencies
```
Expected: ten `passed ✓` lines, then `Packaged: …/markdown-pr-review-1.7.0.vsix`. vsce may warn that `repository` points upstream; that is expected.

- [ ] **Step 3: Install (human)**

The fork registers the same command ids as the original, so disable or uninstall `frankledo.markdown-pr-review` first. Then:

```bash
code --install-extension markdown-pr-review-1.7.0.vsix --force
```
Reload VS Code.

- [ ] **Step 4: Manual check (human): real documents**

In any repository you use with a PR open, check out its branch, open a long markdown file in the PR, and open the review panel. Check the following:
- links to numbered sections
- explicit `<a id>` anchors, including inside table cells and headings
- relative links to other markdown files, including files not in the PR
- ← / → and the keyboard shortcut
- the outline: depth, filter, counts, active section

Note anything that differs from the fixtures.

- [ ] **Step 5: Commit**

```bash
git add package.json
git commit -m "chore: fork identity for local packaging (not for upstream)"
git push -u origin fork-build
```

---

### Task 8: Open links in a new review panel

**Files:**
- Create: `src/ReviewSession.ts`, `test/review-session.test.ts`
- Modify: `src/ReviewPanel.ts` (singleton → one panel per tab sharing a session), `src/extension.ts`, `src/links.ts`, `test/links-host.test.ts`, `src/types.ts`, `webview/main.ts`, `webview/draft.ts`, `package.json`

**Interfaces:**
- Consumes: `_runNavigation`, `_show`, `_navigateTo`, `_openLink`, `_postHistoryState`, `requestNavigate` (Tasks 4–5); `prepareDraftComments` and `DraftComment` (Task 3); `classifyHref`, `LinkAction` and `jumpToFragment` (Tasks 2 and 5).
- Produces, `src/ReviewSession.ts`. It is free of the `vscode` API, so it can be unit-tested:
  - `interface SessionContext { owner; repo; prNumber; headSha; repoRoot; prFiles: PrFile[]; validLinesByPath: Map<string, number[]>; currentUserLogin }`. This is today's `PrContext` without `filePath`.
  - `type SessionChange = { kind: 'drafts'; count: number } | { kind: 'comments'; path: string }`
  - `interface SessionView { readonly filePath: string; onSessionChange(change: SessionChange): void }`
  - `class ReviewSession<V extends SessionView>` with:
    - `ctx`, a `prFiles` getter and setter
    - `isSameReview(ctx)`, `refresh(ctx)`
    - `views`, `viewCount`, `active`, `attach(v)`, `setActive(v)`, `detach(v)`
    - `drafts`, `draftCount`, `addDraft(d)`, `clearDrafts()`
    - `commentsChanged(path, source)`
- Produces, `src/links.ts`: `opensNewPanel(setting: string | undefined, modifier: boolean): boolean`.
- Produces, `ReviewPanel`:
  - removes `static currentPanel` and `createOrShow`
  - adds `static get active(): ReviewPanel | undefined` and `static openReview(extensionUri, markdown, comments, threadMeta, ctx: PrContext): void`
  - `render(markdown, comments, threadMeta, filePath: string)` (was `ctx: PrContext`)
  - `PrContext` becomes `SessionContext & { filePath }`
- Produces, messages: `openLink` gains `modifier: boolean`. A new host → webview message `{ type: 'draftCount'; count: number }`.
- Produces, setting: `markdownPrReview.openLinks`, either `"inPanel"` (default) or `"newPanel"`. Cmd/Ctrl-click or middle-click inverts it.

**Design.** Today `ReviewPanel` is a singleton that holds both the PR state and the view. A second panel would otherwise get its own drafts (two separate reviews, or drafts lost when a tab closes) and its own copy of the comments (stale once the other panel resolves a thread). The task splits them:

| Lives on | State |
|---|---|
| `ReviewSession` (one per PR) | PR context, the pending review's drafts, which panel is active, and notifying other panels |
| `ReviewPanel` (one per tab) | the webview, the current file, history, cached render, the outline (inside its webview) |

A comment change in one panel reloads the other panels showing the same file. A draft change updates every panel's badge. Submit from any panel sends every draft in the session. To keep the change small, `ReviewPanel` keeps its `_owner`, `_repo` and other names as private getters that read from the session.

- [ ] **Step 1: Branch**

```bash
git switch feat/navigation
git switch -c feat/multi-panel
git push -u origin feat/multi-panel
gh pr create --repo "$(gh repo view --json nameWithOwner -q .nameWithOwner)" --base main --head feat/multi-panel --draft --title "Open links in a new review panel" --body "Test PR for multi-panel review. Not for merge."
```

- [ ] **Step 2: Write the failing tests**

Create `test/review-session.test.ts`:

```ts
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
```

Add to `test/links-host.test.ts`, before its `console.log`:

```ts
import { opensNewPanel } from '../src/links';

assert.equal(opensNewPanel(undefined, false), false);
assert.equal(opensNewPanel(undefined, true), true);
assert.equal(opensNewPanel('inPanel', true), true);
assert.equal(opensNewPanel('newPanel', false), true);
assert.equal(opensNewPanel('newPanel', true), false);
```
Move the `import` line up with the file's other imports, merging it into `import { resolveLink, isMarkdownPath, opensNewPanel } from '../src/links';`.

Append ` && npx tsx test/review-session.test.ts` to `scripts.test`.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx tsx test/review-session.test.ts; npx tsx test/links-host.test.ts`
Expected: the first fails with `Cannot find module '../src/ReviewSession'`. The second fails with `opensNewPanel is not a function`, or a `SyntaxError` naming the missing export.

- [ ] **Step 4: Implement `src/ReviewSession.ts`**

```ts
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
```

Add to `src/links.ts`:

```ts
// Cmd/Ctrl-click and middle-click invert the configured default, as in a browser.
export function opensNewPanel(setting: string | undefined, modifier: boolean): boolean {
  return (setting === 'newPanel') !== modifier;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx tsx test/review-session.test.ts && npx tsx test/links-host.test.ts`
Expected: `All review-session tests passed ✓` and `All links-host tests passed ✓`

- [ ] **Step 6: Message types**

In `src/types.ts`:
- Change `| { type: 'openLink'; href: string; scrollTop: number }` to `| { type: 'openLink'; href: string; scrollTop: number; modifier: boolean }`.
- Add to `ExtensionMessage`: `| { type: 'draftCount'; count: number }`.

- [ ] **Step 7: Split `src/ReviewPanel.ts` into panels sharing a session**

Make these edits in order. Where code below differs from the file, the file is the version Tasks 3–6 left behind.

1. Imports. Change the `./types` import to also bring in `ExtensionMessage`:
   ```ts
   import type { ExtensionMessage, PRComment, PrFile, RenderMessage, ThreadMeta, WebviewMessage } from './types';
   ```
   Change `import { prepareDraftComments, type DraftComment } from './drafts';` to `import { prepareDraftComments } from './drafts';`. Change the links import to `import { resolveLink, isMarkdownPath, opensNewPanel } from './links';`. Add:
   ```ts
   import { ReviewSession, type SessionChange, type SessionContext, type SessionView } from './ReviewSession';
   ```

2. Replace the `PrContext` interface with:
   ```ts
   export interface PrContext extends SessionContext {
     filePath: string;
   }
   ```

3. Change `export class ReviewPanel {` to `export class ReviewPanel implements SessionView {`.

4. Replace `static currentPanel: ReviewPanel | undefined;` and the whole `static createOrShow(…) { … }` method with:
   ```ts
   private static _session: ReviewSession<ReviewPanel> | undefined;

   // The panel the reader last focused; the back/forward commands act on it.
   static get active(): ReviewPanel | undefined {
     return ReviewPanel._session?.active;
   }

   // Opens the review for a PR in the active panel, or a new one. Re-opening the same PR keeps
   // its drafts; a different PR closes the old panels (warning if drafts would be lost).
   static openReview(
     extensionUri: vscode.Uri,
     markdown: string,
     comments: PRComment[],
     threadMeta: ThreadMeta[],
     ctx: PrContext
   ): void {
     const { filePath, ...sessionCtx } = ctx;
     let session = ReviewPanel._session;
     if (session && session.isSameReview(sessionCtx)) {
       session.refresh(sessionCtx);
     } else {
       session?.views.forEach(view => view.dispose());
       session = new ReviewSession<ReviewPanel>(sessionCtx);
       ReviewPanel._session = session;
     }
     const panel = session.active ?? ReviewPanel._create(extensionUri, session);
     panel._panel.reveal(vscode.ViewColumn.Beside);
     panel.render(markdown, comments, threadMeta, filePath);
   }

   private static _create(extensionUri: vscode.Uri, session: ReviewSession<ReviewPanel>): ReviewPanel {
     const panel = vscode.window.createWebviewPanel(
       'markdownPrReview',
       'PR Review',
       vscode.ViewColumn.Beside,
       {
         enableScripts: true,
         enableFindWidget: true,
         localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')],
       }
     );
     return new ReviewPanel(panel, extensionUri, session);
   }
   ```

5. Replace the field block from `private _owner = '';` through `private _draftComments: DraftComment[] = [];` (the PR fields, `_filePath`, `_prFiles`, `_validLinesByPath`, `_currentUserLogin`, `_draftComments`) with:
   ```ts
   private readonly _session: ReviewSession<ReviewPanel>;
   private _filePath = '';
   private _webviewReady = false;
   private _pendingScroll: ExtensionMessage | undefined;
   private _disposed = false;

   // PR context lives on the session, shared by every panel open on the PR.
   private get _owner(): string { return this._session.ctx.owner; }
   private get _repo(): string { return this._session.ctx.repo; }
   private get _prNumber(): number { return this._session.ctx.prNumber; }
   private get _headSha(): string { return this._session.ctx.headSha; }
   private get _repoRoot(): string { return this._session.ctx.repoRoot; }
   private get _validLinesByPath(): Map<string, number[]> { return this._session.ctx.validLinesByPath; }
   private get _currentUserLogin(): string { return this._session.ctx.currentUserLogin; }
   private get _prFiles(): PrFile[] { return this._session.prFiles; }
   private set _prFiles(files: PrFile[]) { this._session.prFiles = files; }

   get filePath(): string {
     return this._filePath;
   }
   ```

6. Constructor. Change the signature to `private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, session: ReviewSession<ReviewPanel>) {`. After `this._extensionUri = extensionUri;`, add:
   ```ts
       this._session = session;
       session.attach(this);
   ```
   Replace the `onDidChangeViewState` handler with:
   ```ts
       this._panel.onDidChangeViewState(({ webviewPanel }) => {
         if (webviewPanel.active) this._session.setActive(this);
         if (webviewPanel.visible && this._lastRenderMsg) {
           this._panel.webview.postMessage(this._lastRenderMsg);
         }
       }, null, this._disposables);
   ```

7. Replace the whole `render(…)` method with:
   ```ts
   render(markdown: string, comments: PRComment[], threadMeta: ThreadMeta[], filePath: string): void {
     this._filePath = filePath;
     this._history = new NavHistory();
     this._panel.title = this._title(filePath);

     this._lastRenderMsg = {
       type: 'render',
       markdown,
       comments,
       threadMeta,
       owner: this._owner,
       repo: this._repo,
       prNumber: this._prNumber,
       prFiles: this._prFiles,
       filePath,
       headSha: this._headSha,
       currentUserLogin: this._currentUserLogin,
       validLines: this._validLinesByPath.get(filePath) ?? [],
       draftCount: this._session.draftCount,
       readOnly: !this._prFiles.some(f => f.path === filePath),
     };
     this._panel.webview.postMessage(this._lastRenderMsg);
     this._postHistoryState();
   }

   // With several panels open, each tab names its file.
   private _title(relPath: string): string {
     return `PR #${this._prNumber} · ${path.basename(relPath)}`;
   }
   ```

8. In `_loadAndRender`, replace `this._panel.title = 'Markdown PR Review';` with `this._panel.title = this._title(relPath);`. Replace `draftCount: this._draftComments.length,` with `draftCount: this._session.draftCount,`.

9. In `_syncDraftCount`, replace `this._draftComments.length` with `this._session.draftCount`.

10. Replace the `ready` branch of `_handleMessage` with:
    ```ts
        if (msg.type === 'ready') {
          this._webviewReady = true;
          if (this._lastRenderMsg) {
            this._panel.webview.postMessage(this._lastRenderMsg);
          }
          this._postHistoryState();
          if (this._pendingScroll) {
            this._panel.webview.postMessage(this._pendingScroll);
            this._pendingScroll = undefined;
          }
          return;
        }
    ```

11. In the `openLink` branch, replace `this._openLink(msg.href, msg.scrollTop)` with `this._openLink(msg.href, msg.scrollTop, msg.modifier)`.

12. Replace the `addToDraft` branch body:
    ```ts
          } else if (msg.type === 'addToDraft') {
            this._session.addDraft({ path: this._filePath, line: msg.line, body: msg.body });
    ```
    The session broadcasts the count. `onSessionChange` (below) does what `_syncDraftCount()` did here, so remove that call from this branch.

13. In the `submitReview` branch:
    - Replace `this._draftComments,` (first argument of `prepareDraftComments`) with `[...this._session.drafts],`.
    - Replace the two lines `this._draftComments = [];` and `this._syncDraftCount();` with `this._session.clearDrafts();`.
    - After its `postMessage({ type: 'reviewSubmitted', … })`, add:
    ```ts
            for (const changed of new Set(comments.map(c => c.path).filter((p): p is string => !!p))) {
              this._session.commentsChanged(changed, this);
            }
    ```

14. At the end of the `try` block in `_handleMessage`, after the closing `}` of the `unresolveThread` branch and before `} catch`, add:
    ```ts
          // Posting, editing, deleting and resolving change this file's comments for other panels.
          if (msg.type !== 'addToDraft' && msg.type !== 'submitReview') {
            this._session.commentsChanged(this._filePath, this);
          }
    ```

15. Replace `_openLink`'s signature with `private async _openLink(href: string, scrollTop: number, modifier: boolean): Promise<void> {`. Replace its last line, `await this._navigateTo({ path: link.relPath, fragment: link.fragment }, scrollTop);`, with:
    ```ts
        const setting = vscode.workspace.getConfiguration('markdownPrReview').get<string>('openLinks');
        if (opensNewPanel(setting, modifier)) {
          const panel = ReviewPanel._create(this._extensionUri, this._session);
          await panel._runNavigation(async () => {
            await panel._show({ path: link.relPath, fragment: link.fragment });
          });
          return;
        }
        await this._navigateTo({ path: link.relPath, fragment: link.fragment }, scrollTop);
    ```

16. In `_show`, replace the `this._panel.webview.postMessage( … );` statement with:
    ```ts
        const scroll: ExtensionMessage = target.fragment
          ? { type: 'scrollTo', fragment: target.fragment }
          : { type: 'scrollTo', scrollTop: target.scrollTop ?? 0 };
        // A panel opened for this link has not loaded its script yet; 'ready' delivers the scroll.
        if (this._webviewReady) this._panel.webview.postMessage(scroll);
        else this._pendingScroll = scroll;
    ```

17. Add after `requestNavigate`:
    ```ts
      onSessionChange(change: SessionChange): void {
        if (change.kind === 'drafts') {
          this._syncDraftCount();
          this._panel.webview.postMessage({ type: 'draftCount', count: change.count });
          return;
        }
        // Another panel changed comments on the file this one shows: reload it.
        void this._runNavigation(async () => {
          await this._loadAndRender(this._filePath);
        });
      }
    ```

18. Replace the whole `dispose()` method with:
    ```ts
      dispose(): void {
        if (this._disposed) return; // _panel.dispose() fires onDidDispose, which calls back here
        this._disposed = true;
        const session = this._session;
        if (session.viewCount === 1 && session.draftCount > 0) {
          const n = session.draftCount;
          vscode.window.showWarningMessage(
            `You have ${n} pending draft comment${n > 1 ? 's' : ''} that will be lost.`
          );
        }
        session.detach(this);
        if (session.viewCount === 0 && ReviewPanel._session === session) ReviewPanel._session = undefined;
        this._panel.dispose();
        this._disposables.forEach(d => d.dispose());
        this._disposables.length = 0;
      }
    ```

Confirm nothing still uses the removed names:

```bash
grep -n "_draftComments\|currentPanel\|createOrShow" src/*.ts
```
Expected: no output.

- [ ] **Step 8: `src/extension.ts`**

Replace:

```ts
            const panel = ReviewPanel.createOrShow(context.extensionUri);
            panel.render(
              markdown,
              comments,
              threadMetaResult,
              {
```

with:

```ts
            ReviewPanel.openReview(
              context.extensionUri,
              markdown,
              comments,
              threadMetaResult,
              {
```

The object literal and the closing `);` stay as they are. In the two navigation commands added in Task 5, replace `ReviewPanel.currentPanel?.` with `ReviewPanel.active?.`.

- [ ] **Step 9: Webview (`webview/main.ts`, `webview/draft.ts`)**

In `webview/draft.ts`, add after `add(…)`:

```ts
  // Another panel added or submitted drafts in the same review.
  setCount(count: number): void {
    if (count === 0) {
      this.clear();
      return;
    }
    this._count = count;
    this._render();
  }
```

In `webview/main.ts`, change the links import to `import { classifyHref, type LinkAction } from './links';`. Replace the click handler with:

```ts
// VS Code webviews block link navigation, so every link is routed here.
// Cmd/Ctrl-click and middle-click ask for the other placement (see markdownPrReview.openLinks).
document.addEventListener('click', (e) => {
  const a = (e.target as Element).closest('a');
  if (!a) return;
  const action = classifyHref(a.getAttribute('href'));
  if (action.kind === 'ignore') return;
  e.preventDefault();
  followLink(action, e.metaKey || e.ctrlKey);
});

document.addEventListener('auxclick', (e) => {
  if (e.button !== 1) return;
  const a = (e.target as Element).closest('a');
  if (!a) return;
  const action = classifyHref(a.getAttribute('href'));
  if (action.kind === 'ignore') return;
  e.preventDefault();
  followLink(action, true);
});

function followLink(action: Exclude<LinkAction, { kind: 'ignore' }>, modifier: boolean): void {
  if (action.kind === 'fragment' && !modifier) {
    jumpToFragment(action.id);
    return;
  }
  const href = action.kind === 'fragment' ? `#${encodeURIComponent(action.id)}` : action.href;
  vscode.postMessage({ type: 'openLink', href, scrollTop: window.scrollY, modifier });
}
```

In the `message` listener, add after the `notice` branch:

```ts
  if (msg.type === 'draftCount') {
    draft?.setCount(msg.count);
    return;
  }
```

- [ ] **Step 10: The setting (`package.json`)**

Inside `"contributes"`, add after the `"keybindings"` array:

```json
    "configuration": {
      "title": "Markdown PR Review",
      "properties": {
        "markdownPrReview.openLinks": {
          "type": "string",
          "enum": ["inPanel", "newPanel"],
          "enumDescriptions": [
            "Follow links to other files in the same review panel. Cmd/Ctrl-click or middle-click opens a new panel.",
            "Open links to other files in a new review panel. Cmd/Ctrl-click or middle-click follows them in the same panel."
          ],
          "default": "inPanel",
          "description": "Where links to other markdown files open in the review panel."
        }
      }
    },
```

- [ ] **Step 11: Build, test, type-check**

```bash
npm test && npm run compile
npx tsc -p tsconfig.json --noEmit > ../tsc-now-ext.txt 2>&1; diff ../tsc-baseline-ext.txt ../tsc-now-ext.txt
npx tsc -p tsconfig.webview.json --noEmit > ../tsc-now-webview.txt 2>&1; diff ../tsc-baseline-webview.txt ../tsc-now-webview.txt
```
Expected: eleven `passed ✓` lines and `Build complete.`. No added type errors.

- [ ] **Step 12: Manual check (human)**

Restart the dev host (stop, then F5), because `package.json` changed. Open the panel on `index.md`.
- Cmd/Ctrl-click "Scenario S2 in the other file". Expected: a second panel opens beside the first, titled "PR #n · other.md", at S2. Its ← is disabled. The first panel is unchanged, and its ← still works.
- Middle-click "The other file, top". Expected: a third panel, at the top.
- Cmd/Ctrl-click "Open question Q1". Expected: a new panel on `index.md` at Q1.
- With `index.md` open in two panels, post a comment in one. Expected: the other reloads and shows the bubble. Resolve it in either one. Expected: both update.
- Add a draft in one panel and another in a second. Expected: every panel's badge reads 2. Submit from either. Expected: all badges clear, and each comment lands on its own file on GitHub.
- Focus a panel and press the back shortcut. Expected: only that panel moves.
- Set `markdownPrReview.openLinks` to `newPanel`. Expected: a plain click opens a new panel and Cmd/Ctrl-click stays in place. Same-file `#` links stay in place on a plain click either way.
- With drafts pending, close every panel but one. Expected: no warning. Close the last one. Expected: the "pending draft comments" warning.
- Run **Open Review Panel** again on the same branch. Expected: drafts are kept. Check out the `fix/link-navigation` branch (a different PR) and run it. Expected: the old panels close, warning first if drafts are pending.

- [ ] **Step 13: Commit and push**

```bash
git add src/ReviewSession.ts test/review-session.test.ts src/ReviewPanel.ts src/extension.ts src/links.ts test/links-host.test.ts src/types.ts webview/main.ts webview/draft.ts package.json
git commit -m "feat: open links in a new review panel, with panels sharing one review session"
git push
```

- [ ] **Step 14: Rebuild the fork package**

```bash
git switch fork-build
git merge --no-ff feat/multi-panel -m "Merge feat/multi-panel into fork build"
```
In `package.json`, set `"version": "1.8.0"`.

```bash
npm test && npx vsce package --no-dependencies
git add package.json
git commit -m "chore: fork build 1.8.0"
git push
code --install-extension markdown-pr-review-1.8.0.vsix --force
```
Expected: eleven `passed ✓` lines and `Packaged: …/markdown-pr-review-1.8.0.vsix`. Reload VS Code afterwards.

---

## Self-review notes

- Background coverage:
  - Defect 1 → Task 2.
  - Defect 2 → Task 1.
  - Defect 3 → Task 4.
  - Draft loss and the missing `validLines` → Task 3.
  - Back/forward, with its buttons, commands, keybindings, mouse buttons, file switches and scroll restore → Task 5.
  - Outline, with depth, filter, active section, counts, history on jump and persisted state → Task 6.
  - Fork packaging, with upstream-safe branches → Tasks 0, 4 (Step 12) and 7.
  - Opening in a new panel, with modifier click, middle-click, the setting, shared drafts, cross-panel comment refresh and per-panel history → Task 8, which rebuilds the fork package at Step 14.
- Known limits, deliberately not addressed:
  - Headings inside `<details>` are left out of the outline. Their `data-line` is relative to the block, an existing renderer limitation that also affects comment anchoring.
  - Whether mouse side buttons reach a webview is unverified.
  - Several navigations fired at once are dropped while one is loading (`_navigating`), not queued.
