import { renderMarkdown } from './renderer';
import { placeOverlays, initSelectionHandlers, type OverlayCallbacks } from './overlay';
import { resolveDiagramAnchors, type Point } from './diagram-anchors';
import { createComposeBox } from './compose';
import { DraftManager } from './draft';
import { NavStrip } from './nav';
import { insertAfterInTable } from './thread';
import { classifyHref, type LinkAction } from './links';
import { mountHistoryControls } from './history-controls';
import { OutlinePanel, type OutlineState } from './outline';
import { countOpenThreadsBySection, activeHeadingIndex, type HeadingInfo } from './outline-model';
import type { ExtensionMessage, PRComment, RenderMessage, ThreadMeta } from '../src/types';

declare const mermaid: {
  initialize(opts: object): void;
  run(opts: { nodes: NodeList | HTMLElement[] }): Promise<void>;
};

declare const acquireVsCodeApi: () => {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};
const vscode = acquireVsCodeApi();

// Left-hand header group: history buttons (and, later, the outline toggle).
const headerLeft = document.createElement('span');
headerLeft.className = 'pr-header-left';
document.getElementById('review-header')!.prepend(headerLeft);
const historyControls = mountHistoryControls(headerLeft, () => navigate('back'), () => navigate('forward'));

function navigate(direction: 'back' | 'forward'): void {
  vscode.postMessage({ type: 'navigate', direction, scrollTop: window.scrollY });
}

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

let allComments: PRComment[] = [];
let allThreadMeta: ThreadMeta[] = [];
let validLines: number[] = [];
let currentUserLogin = '';
let draft!: DraftManager;
let contentEl: HTMLElement | null = null;
let selectionHandlersReady = false;
let openThreadIds: Set<number> = new Set();
let navStrip: NavStrip | undefined;
let diagramAnchors: Map<number, Point> = new Map();
let currentMarkdown = '';
let readOnly = false;
let renderDone: Promise<void> = Promise.resolve();

function countThreads(): number {
  return document.querySelectorAll<HTMLElement>('[data-thread-id]').length;
}

const LINE_META_RE = /\n\n---\n\*Comment on line (\d+)\*$/;

function processComment(c: PRComment): PRComment {
  const m = c.body.match(LINE_META_RE);
  if (!m) return c;
  return { ...c, body: c.body.slice(0, m.index as number), line: parseInt(m[1], 10) };
}

function fileShortName(filePath: string, allPaths: string[]): string {
  const base = filePath.split('/').pop()!;
  const hasDupe = allPaths.filter(p => p.split('/').pop() === base).length > 1;
  return hasDupe ? filePath.split('/').slice(-2).join('/') : base;
}

function countSuffix(openCount: number, resolvedCount: number): string {
  const total = openCount + resolvedCount;
  if (total === 0) return '';
  if (openCount > 0 && resolvedCount > 0) return ` (${openCount} open, ${resolvedCount} resolved)`;
  if (openCount > 0) return ` (${openCount} open)`;
  return ` (${resolvedCount} resolved)`;
}

function fileOptionLabel(filePath: string, openCount: number, resolvedCount: number, allPaths: string[]): string {
  return fileShortName(filePath, allPaths) + countSuffix(openCount, resolvedCount);
}

function fileFullLabel(filePath: string, openCount: number, resolvedCount: number): string {
  return filePath + countSuffix(openCount, resolvedCount);
}

function updateCurrentFileOption(): void {
  const selectEl = document.querySelector<HTMLSelectElement>('.pr-file-select');
  if (!selectEl) return;
  const opt = selectEl.options[selectEl.selectedIndex];
  if (!opt) return;
  const allPaths = Array.from(selectEl.options).map(o => o.value);
  const currentPath = opt.value;
  const openCount = allThreadMeta.filter(t => t.path === currentPath && !t.isResolved).length;
  const resolvedCount = allThreadMeta.filter(t => t.path === currentPath && t.isResolved).length;
  const label = fileOptionLabel(opt.value, openCount, resolvedCount, allPaths);
  opt.textContent = label;
  opt.dataset.shortLabel = label;
  opt.dataset.fullLabel = fileFullLabel(opt.value, openCount, resolvedCount);
}

function showToast(message: string): void {
  const toast = document.createElement('div');
  toast.className = 'pr-toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

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

// A jump the reader makes within this file: record where they were, then move.
function jumpToFragment(id: string): void {
  if (findFragmentTarget(id)) vscode.postMessage({ type: 'historyPush', scrollTop: window.scrollY });
  revealFragment(id);
}

function placeOverlaysKeepOpen(): void {
  placeOverlays(contentEl!, allComments, allThreadMeta, buildCallbacks(), diagramAnchors);
  navStrip?.refresh(countThreads());
  refreshOutline();
  document.querySelectorAll<HTMLElement>('[data-thread-id]').forEach(bubble => {
    if (openThreadIds.has(Number(bubble.dataset.threadId))) bubble.click();
  });
}

function buildCallbacks(): OverlayCallbacks {
  return {
    onReply: (panel, rootId, line) => {
      panel.querySelector('.pr-compose')?.remove();
      const box = createComposeBox({
        hasDraft: () => draft.count > 0,
        onPostImmediately: (body) => {
          const tempId = -Date.now();
          allComments.push({
            id: tempId,
            node_id: '',
            in_reply_to_id: rootId,
            line,
            body,
            user: { login: currentUserLogin, avatar_url: '' },
            created_at: new Date().toISOString(),
          });
          box.remove();
          placeOverlays(contentEl!, allComments, allThreadMeta, buildCallbacks());
          navStrip?.refresh(countThreads());
          vscode.postMessage({ type: 'postReply', inReplyToId: rootId, line, body, tempId });
        },
        onAddToDraft: (body) => { draft.add(line, body); },
        onCancel: () => {},
      });
      panel.appendChild(box);
    },
    currentUserLogin,
    onEdit: (commentId, newBody) => {
      vscode.postMessage({ type: 'editComment', commentId, body: newBody });
    },
    onDelete: (commentId) => {
      vscode.postMessage({ type: 'deleteComment', commentId });
    },
    onResolve: (threadNodeId) => {
      vscode.postMessage({ type: 'resolveThread', threadNodeId });
    },
    onUnresolve: (threadNodeId) => {
      vscode.postMessage({ type: 'unresolveThread', threadNodeId });
    },
    onThreadToggle: (rootId, isOpen) => {
      if (isOpen) {
        openThreadIds.add(rootId);
      } else {
        openThreadIds.delete(rootId);
      }
    },
  };
}

function insertComposeAfter(anchor: HTMLElement, box: HTMLElement): void {
  const tag = anchor.tagName.toLowerCase();
  if (tag === 'li') {
    anchor.querySelector('.pr-compose')?.remove();
    anchor.appendChild(box);
    return;
  }
  if (anchor.parentElement?.tagName.toLowerCase() === 'li') {
    anchor.parentElement.querySelector('.pr-compose')?.remove();
    anchor.parentElement.appendChild(box);
    return;
  }
  // Table cell: inject a full-width row so the compose box doesn't break the table layout.
  // Override box.remove so the wrapper row is torn down when the compose is dismissed.
  const removeWrapper = insertAfterInTable(anchor, box);
  if (removeWrapper) {
    const orig = box.remove.bind(box);
    box.remove = () => { orig(); removeWrapper(); };
    return;
  }
  anchor.nextElementSibling?.classList.contains('pr-compose') && anchor.nextElementSibling.remove();
  anchor.insertAdjacentElement('afterend', box);
}

// Returns the 0-indexed line number if the selected text matches exactly one
// line in the markdown source. Falls back to the data-line block anchor otherwise.
function findExactLine(selected: string, fallback: number): number {
  const needle = selected.split('\n').map(l => l.trim()).find(l => l.length >= 3);
  if (!needle) return fallback;
  const lines = currentMarkdown.split('\n');
  const matches = lines.reduce<number[]>((acc, l, i) => {
    if (l.includes(needle)) acc.push(i);
    return acc;
  }, []);
  return matches.length === 1 ? matches[0] : fallback;
}

function onAddComment(anchor: HTMLElement, line: number): void {
  const selected = window.getSelection()?.toString() ?? '';
  const exactLine = findExactLine(selected, line);
  const box = createComposeBox({
    hasDraft: () => draft.count > 0,
    onPostImmediately: (body) => {
      const tempId = -Date.now();
      allComments.push({
        id: tempId,
        node_id: '',
        line: exactLine + 1,
        body,
        user: { login: currentUserLogin, avatar_url: '' },
        created_at: new Date().toISOString(),
      });
      box.remove();
      placeOverlays(contentEl!, allComments, allThreadMeta, buildCallbacks());
      navStrip?.refresh(countThreads());
      vscode.postMessage({ type: 'postComment', line: exactLine, body, tempId });
    },
    onAddToDraft: (body) => { draft.add(exactLine, body); },
    onCancel: () => {},
  });
  insertComposeAfter(anchor, box);
}

vscode.postMessage({ type: 'ready' });

document.addEventListener('keydown', (e) => {
  if ((e.target as Element).closest('textarea, input')) return;
  if (e.key === '[') { e.preventDefault(); navStrip?.prev(); }
  if (e.key === ']') { e.preventDefault(); navStrip?.next(); }
  if (e.key === 'o' && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); outline.toggle(); }
});

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

// Mouse back/forward buttons, where the platform delivers them to the webview.
document.addEventListener('mouseup', (e) => {
  if (e.button === 3) { e.preventDefault(); navigate('back'); }
  if (e.button === 4) { e.preventDefault(); navigate('forward'); }
});

window.addEventListener('message', (event: MessageEvent<ExtensionMessage>) => {
  const msg = event.data;

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

  if (msg.type === 'draftCount') {
    draft?.setCount(msg.count);
    return;
  }

  if (msg.type === 'historyState') {
    historyControls.setState(msg.canGoBack, msg.canGoForward);
    return;
  }

  if (msg.type === 'requestNavigate') {
    navigate(msg.direction);
    return;
  }

  if (!contentEl) return;

  if (msg.type === 'commentPosted' || msg.type === 'replyPosted') {
    allComments = allComments.map(c => c.id === msg.tempId ? processComment(msg.comment) : c);
    placeOverlaysKeepOpen();
    if (msg.snapped) showToast('Not on a changed line — anchored nearby. Original line noted in comment.');
    return;
  }

  if (msg.type === 'reviewSubmitted') {
    allComments = [...allComments, ...msg.comments.map(processComment)];
    draft?.clear();
    placeOverlaysKeepOpen();
    return;
  }

  if (msg.type === 'commentEdited') {
    allComments = allComments.map(c => {
      if (c.id !== msg.commentId) return c;
      const m = msg.body.match(LINE_META_RE);
      return m
        ? { ...c, body: msg.body.slice(0, m.index as number), line: parseInt(m[1], 10) }
        : { ...c, body: msg.body };
    });
    placeOverlaysKeepOpen();
    return;
  }

  if (msg.type === 'commentDeleted') {
    allComments = allComments.filter(c => c.id !== msg.commentId && c.in_reply_to_id !== msg.commentId);
    placeOverlaysKeepOpen();
    return;
  }

  if (msg.type === 'threadResolved') {
    allThreadMeta = allThreadMeta.map(m =>
      m.nodeId === msg.threadNodeId ? { ...m, isResolved: true } : m
    );
    placeOverlaysKeepOpen();
    updateCurrentFileOption();
    return;
  }

  if (msg.type === 'threadUnresolved') {
    allThreadMeta = allThreadMeta.map(m =>
      m.nodeId === msg.threadNodeId ? { ...m, isResolved: false } : m
    );
    placeOverlaysKeepOpen();
    updateCurrentFileOption();
    return;
  }

  if (msg.type === 'postError') {
    if (msg.tempId != null) {
      allComments = allComments.filter(c => c.id !== msg.tempId);
      placeOverlaysKeepOpen();
      showToast(`Failed to post — ${msg.message}`);
    } else if (msg.source === 'draft') {
      draft.showError(`Submit failed — ${msg.message}`);
    } else {
      placeOverlaysKeepOpen();
      showToast(`Action failed — ${msg.message}`);
    }
  }
});

async function handleRender(msg: RenderMessage): Promise<void> {
  contentEl = document.getElementById('content');
  if (!contentEl) return;

  currentUserLogin = msg.currentUserLogin;
  allComments = msg.comments.map(processComment);
  allThreadMeta = [...msg.threadMeta];
  validLines = msg.validLines ?? [];
  readOnly = msg.readOnly ?? false;

  // Build/update file-switcher dropdown in-place to avoid destroying NavStrip DOM
  const headerEl = document.getElementById('review-header')!;
  let selectEl = headerEl.querySelector<HTMLSelectElement>('.pr-file-select');
  if (!selectEl) {
    selectEl = document.createElement('select');
    selectEl.className = 'pr-file-select';
    selectEl.addEventListener('change', () => {
      vscode.postMessage({ type: 'switchFile', path: selectEl!.value, scrollTop: window.scrollY });
    });
    selectEl.addEventListener('mousedown', () => {
      Array.from(selectEl!.options).forEach(o => { o.textContent = o.dataset.fullLabel ?? o.value; });
    });
    selectEl.addEventListener('blur', () => {
      Array.from(selectEl!.options).forEach(o => { o.textContent = o.dataset.shortLabel ?? o.value; });
    });
    headerEl.appendChild(selectEl);
  }
  selectEl.innerHTML = '';
  const allPaths = msg.prFiles.map(x => x.path);
  for (const f of msg.prFiles) {
    const opt = document.createElement('option');
    opt.value = f.path;
    opt.dataset.shortLabel = fileOptionLabel(f.path, f.openCount, f.resolvedCount, allPaths);
    opt.dataset.fullLabel = fileFullLabel(f.path, f.openCount, f.resolvedCount);
    opt.textContent = opt.dataset.shortLabel;
    opt.selected = f.path === msg.filePath;
    selectEl.appendChild(opt);
  }
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

  currentMarkdown = msg.markdown;
  contentEl.innerHTML = renderMarkdown(msg.markdown);
  collectHeadings(contentEl);

  const isDark =
    document.body.classList.contains('vscode-dark') ||
    document.body.classList.contains('vscode-high-contrast');

  mermaid.initialize({ startOnLoad: false, theme: isDark ? 'dark' : 'default' });

  const mermaidNodes = contentEl.querySelectorAll<HTMLElement>('.mermaid');
  const mermaidSources = new Map<HTMLElement, string>();
  mermaidNodes.forEach(el => mermaidSources.set(el, el.textContent?.trim() ?? ''));

  if (mermaidNodes.length > 0) {
    await mermaid.run({ nodes: mermaidNodes });
  }

  diagramAnchors = resolveDiagramAnchors(contentEl, allComments, mermaidSources);
  placeOverlays(contentEl, allComments, allThreadMeta, buildCallbacks(), diagramAnchors);

  const header = document.getElementById('review-header')!;
  if (!navStrip) {
    navStrip = new NavStrip(
      header,
      () => Array.from(document.querySelectorAll<HTMLElement>('[data-thread-id]')),
      () => { openThreadIds.clear(); }
    );
  }
  navStrip.update(countThreads());
  refreshOutline();
  outline.layout();
  updateActiveHeading();

  // Re-open threads that were open before the tab switch, filtered to bubbles present in DOM
  document.querySelectorAll<HTMLElement>('[data-thread-id]').forEach(bubble => {
    if (openThreadIds.has(Number(bubble.dataset.threadId))) bubble.click();
  });

  draft?.clear();
  draft = new DraftManager(vscode, header, msg.draftCount ?? 0);

  if (!selectionHandlersReady) {
    initSelectionHandlers(contentEl, onAddComment, () => validLines, () => readOnly);
    selectionHandlersReady = true;
  }
}
