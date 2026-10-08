import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { ExtensionMessage, PRComment, PrFile, RenderMessage, ThreadMeta, WebviewMessage } from './types';
import { postComment, postReply, submitDraftReview, getGitHubToken,
         editComment, deleteComment, resolveThread, unresolveThread,
         fetchPrComments, fetchThreadMeta } from './GitHubClient';
import { prepareDraftComments } from './drafts';
import { resolveLink, isMarkdownPath, opensNewPanel } from './links';
import { NavHistory, type HistoryLocation } from './history';
import { ReviewSession, type SessionChange, type SessionContext, type SessionView } from './ReviewSession';

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

export interface PrContext extends SessionContext {
  filePath: string;
}

export class ReviewPanel implements SessionView {
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

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private readonly _disposables: vscode.Disposable[] = [];

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

  private _lastRenderMsg: RenderMessage | undefined;
  private _navigating = false;
  private _history = new NavHistory();

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, session: ReviewSession<ReviewPanel>) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._session = session;
    session.attach(this);
    this._panel.webview.html = this._buildHtml();
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.onDidChangeViewState(({ webviewPanel }) => {
      if (webviewPanel.active) this._session.setActive(this);
      if (webviewPanel.visible && this._lastRenderMsg) {
        this._panel.webview.postMessage(this._lastRenderMsg);
      }
    }, null, this._disposables);
    this._panel.webview.onDidReceiveMessage(
      (msg: WebviewMessage) => { this._handleMessage(msg).catch(console.error); },
      null,
      this._disposables
    );
  }

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

  private _updateCachedComments(updater: (comments: PRComment[]) => PRComment[]): void {
    if (this._lastRenderMsg) {
      this._lastRenderMsg = { ...this._lastRenderMsg, comments: updater(this._lastRenderMsg.comments) };
    }
  }

  // The cached render is re-sent when the panel is shown again; keep its badge count true.
  private _syncDraftCount(): void {
    if (this._lastRenderMsg) {
      this._lastRenderMsg = { ...this._lastRenderMsg, draftCount: this._session.draftCount };
    }
  }

  private async _loadAndRender(relPath: string): Promise<boolean> {
    let markdown: string;
    try {
      markdown = fs.readFileSync(path.join(this._repoRoot, relPath), 'utf8');
    } catch {
      this._panel.webview.postMessage({ type: 'postError', message: `Could not read file: ${relPath}` });
      return false;
    }

    const { token } = await getGitHubToken();
    const comments = await fetchPrComments(this._owner, this._repo, this._prNumber, relPath, token);

    let threadMeta: ThreadMeta[] = [];
    try {
      threadMeta = await fetchThreadMeta(this._owner, this._repo, this._prNumber, token);
    } catch (err) {
      console.warn('fetchThreadMeta failed on switch:', err);
    }

    this._prFiles = this._prFiles.map(f => ({
      ...f,
      openCount: threadMeta.filter(t => t.path === f.path && !t.isResolved).length,
      resolvedCount: threadMeta.filter(t => t.path === f.path && t.isResolved).length,
    }));
    this._filePath = relPath;

    this._panel.title = this._title(relPath);

    this._lastRenderMsg = {
      type: 'render',
      markdown,
      comments,
      threadMeta,
      owner: this._owner,
      repo: this._repo,
      prNumber: this._prNumber,
      prFiles: this._prFiles,
      validLines: this._validLinesByPath.get(relPath) ?? [],
      filePath: relPath,
      headSha: this._headSha,
      currentUserLogin: this._currentUserLogin,
      draftCount: this._session.draftCount,
      readOnly: !this._prFiles.some(f => f.path === relPath),
    };
    this._panel.webview.postMessage(this._lastRenderMsg);
    return true;
  }

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

  private async _openLink(href: string, scrollTop: number, modifier: boolean): Promise<void> {
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
    const setting = vscode.workspace.getConfiguration('markdownPrReview').get<string>('openLinks');
    if (opensNewPanel(setting, modifier)) {
      const panel = ReviewPanel._create(this._extensionUri, this._session);
      await panel._runNavigation(async () => {
        await panel._show({ path: link.relPath, fragment: link.fragment });
      });
      return;
    }
    await this._navigateTo({ path: link.relPath, fragment: link.fragment }, scrollTop);
  }

  // Shows a location: loads the file if it is not the current one, then asks the webview to
  // scroll. Returns false when the file could not be loaded.
  private async _show(target: { path: string; fragment?: string; scrollTop?: number }): Promise<boolean> {
    if (target.path !== this._filePath && !(await this._loadAndRender(target.path))) return false;
    const scroll: ExtensionMessage = target.fragment
      ? { type: 'scrollTo', fragment: target.fragment }
      : { type: 'scrollTo', scrollTop: target.scrollTop ?? 0 };
    // A panel opened for this link has not loaded its script yet; 'ready' delivers the scroll.
    if (this._webviewReady) this._panel.webview.postMessage(scroll);
    else this._pendingScroll = scroll;
    return true;
  }

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

  // Snap a 1-based line to the nearest diff-visible line for the given file.
  // Prefers at-or-above; falls back to nearest below when the target precedes all hunks.
  // GitHub rejects comments on lines outside the diff context (422).
  private _snapToDiffLine(filePath: string, line: number): number {
    const valid = this._validLinesByPath.get(filePath);
    if (!valid || valid.length === 0) return line;
    let best = -1;
    for (const l of valid) {
      if (l <= line && l > best) best = l;
    }
    if (best !== -1) return best;
    return valid.reduce((a, b) => Math.abs(b - line) < Math.abs(a - line) ? b : a);
  }

  private _snapSuffix(rawLine: number): string {
    return `\n\n---\n*Comment on line ${rawLine}*`;
  }

  private _stripSnapSuffix(body: string): { cleanBody: string; originalLine: number | null } {
    const m = body.match(/\n\n---\n\*Comment on line (\d+)\*$/);
    if (!m) return { cleanBody: body, originalLine: null };
    return { cleanBody: body.slice(0, m.index), originalLine: parseInt(m[1], 10) };
  }

  private async _handleMessage(msg: WebviewMessage): Promise<void> {
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

    if (msg.type === 'switchFile') {
      await this._runNavigation(() => this._navigateTo({ path: msg.path }, msg.scrollTop));
      return;
    }

    if (msg.type === 'openLink') {
      await this._runNavigation(() => this._openLink(msg.href, msg.scrollTop, msg.modifier));
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

    const tempId = (msg as { tempId?: number }).tempId;

    try {
      const { token } = await getGitHubToken();

      if (msg.type === 'postComment') {
        const rawLine = msg.line + 1;
        const snappedLine = this._snapToDiffLine(this._filePath, rawLine);
        const snapped = snappedLine !== rawLine;
        const postedBody = snapped ? `${msg.body}${this._snapSuffix(rawLine)}` : msg.body;
        const comment = await postComment(
          this._owner, this._repo, this._prNumber, token,
          { body: postedBody, commitId: this._headSha, path: this._filePath, line: snappedLine }
        );
        // Send webview the clean body + original line for correct bubble placement
        const displayComment = snapped ? { ...comment, body: msg.body, line: rawLine } : comment;
        // Keep _lastRenderMsg in sync so re-shows after tab-switch include this comment
        this._updateCachedComments(cs => [...cs, comment]);
        this._panel.webview.postMessage({
          type: 'commentPosted', comment: displayComment, tempId: msg.tempId, snapped,
        });

      } else if (msg.type === 'postReply') {
        const comment = await postReply(
          this._owner, this._repo, this._prNumber, token,
          { body: msg.body, inReplyToId: msg.inReplyToId, fallbackLine: msg.line }
        );
        this._updateCachedComments(cs => [...cs, comment]);
        this._panel.webview.postMessage({ type: 'replyPosted', comment, tempId: msg.tempId });

      } else if (msg.type === 'addToDraft') {
        this._session.addDraft({ path: this._filePath, line: msg.line, body: msg.body });

      } else if (msg.type === 'submitReview') {
        const preparedComments = prepareDraftComments(
          [...this._session.drafts],
          (filePath, line) => this._snapToDiffLine(filePath, line),
          rawLine => this._snapSuffix(rawLine)
        );
        const comments = await submitDraftReview(
          this._owner, this._repo, this._prNumber, token,
          { commitId: this._headSha, comments: preparedComments }
        );
        this._session.clearDrafts();
        // A review can span files; only this file's comments belong in the open view.
        const forThisFile = comments.filter(c => c.path === this._filePath);
        this._updateCachedComments(cs => [...cs, ...forThisFile]);
        // Strip metadata so webview places bubbles at original lines
        const displayComments = forThisFile.map(c => {
          const { cleanBody, originalLine } = this._stripSnapSuffix(c.body);
          return originalLine ? { ...c, body: cleanBody, line: originalLine } : c;
        });
        this._panel.webview.postMessage({ type: 'reviewSubmitted', comments: displayComments });
        for (const changed of new Set(comments.map(c => c.path).filter((p): p is string => !!p))) {
          this._session.commentsChanged(changed, this);
        }

      } else if (msg.type === 'editComment') {
        const newBody = await editComment(this._owner, this._repo, msg.commentId, msg.body, token);
        this._updateCachedComments(cs => cs.map(c => c.id === msg.commentId ? { ...c, body: newBody } : c));
        this._panel.webview.postMessage({ type: 'commentEdited', commentId: msg.commentId, body: newBody });

      } else if (msg.type === 'deleteComment') {
        await deleteComment(this._owner, this._repo, msg.commentId, token);
        this._updateCachedComments(cs => cs.filter(c => c.id !== msg.commentId && c.in_reply_to_id !== msg.commentId));
        this._panel.webview.postMessage({ type: 'commentDeleted', commentId: msg.commentId });

      } else if (msg.type === 'resolveThread') {
        await resolveThread(msg.threadNodeId, token);
        this._panel.webview.postMessage({ type: 'threadResolved', threadNodeId: msg.threadNodeId });

      } else if (msg.type === 'unresolveThread') {
        await unresolveThread(msg.threadNodeId, token);
        this._panel.webview.postMessage({ type: 'threadUnresolved', threadNodeId: msg.threadNodeId });
      }
      // Posting, editing, deleting and resolving change this file's comments for other panels.
      if (msg.type !== 'addToDraft' && msg.type !== 'submitReview') {
        this._session.commentsChanged(this._filePath, this);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const source =
        msg.type === 'submitReview' ? 'draft' :
        (msg.type === 'editComment' || msg.type === 'deleteComment' ||
         msg.type === 'resolveThread' || msg.type === 'unresolveThread') ? 'action' :
        undefined;
      this._panel.webview.postMessage({ type: 'postError', message, tempId, source });
    }
  }

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

  private _buildHtml(): string {
    const webview = this._panel.webview;
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview.js')
    );
    const mermaidUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'dist', 'mermaid.min.js')
    );
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src https: data:;">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PR Review</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      padding: 0;
      line-height: 1.6;
    }
    #review-header {
      position: sticky;
      top: 0;
      z-index: 100;
      background: var(--vscode-editor-background);
      border-bottom: 1px solid var(--vscode-widget-border, rgba(255,255,255,0.1));
      padding: 6px 20px;
      min-height: 36px;
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
    }
    #review-header:empty { display: none; }
    #content { max-width: 800px; margin: 0 auto; padding: 20px; }
    .pr-content h1, .pr-content h2, .pr-content h3,
    .pr-content h4, .pr-content h5, .pr-content h6,
    .pr-content a[id] { scroll-margin-top: 64px; }
    .pr-bubble {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      background: var(--vscode-badge-background, #4d4d4d);
      color: var(--vscode-badge-foreground, #fff);
      border-radius: 10px;
      padding: 2px 7px 2px 4px;
      cursor: pointer;
      float: right;
      font-size: 11px;
      line-height: 1;
      height: 20px;
      box-sizing: border-box;
      margin-left: 8px;
      vertical-align: middle;
    }
    .pr-bubble:hover { opacity: 0.85; }
    .pr-bubble-avatar {
      width: 14px; height: 14px; min-width: 14px;
      border-radius: 50%; object-fit: cover; display: block;
    }
    .pr-thread {
      position: relative;
      background: var(--vscode-editor-inactiveSelectionBackground, rgba(255,255,255,0.05));
      border-left: 3px solid var(--vscode-focusBorder, #007acc);
      padding: 8px 12px;
      margin: 6px 0;
      border-radius: 0 4px 4px 0;
      clear: both;
      white-space: normal;
    }
    .pr-thread-close-btn {
      position: absolute;
      top: 4px;
      right: 6px;
      background: none;
      border: none;
      color: var(--vscode-foreground, inherit);
      opacity: 0.5;
      cursor: pointer;
      font-size: 16px;
      line-height: 1;
      padding: 0 2px;
    }
    .pr-thread-close-btn:hover { opacity: 1; }
    .pr-thread-item + .pr-thread-item {
      border-top: 1px solid var(--vscode-widget-border, rgba(255,255,255,0.1));
      margin-top: 8px;
      padding-top: 8px;
    }
    .pr-thread-header {
      display: flex; align-items: center; gap: 6px;
      margin-bottom: 4px; font-size: 12px; opacity: 0.8;
    }
    .pr-thread-avatar { width: 20px; height: 20px; border-radius: 50%; }
    .pr-thread-body { font-size: 13px; word-break: break-word; }
    .pr-thread-body p { margin: 0.3em 0; }
    .pr-thread-body p:first-child { margin-top: 0; }
    .pr-thread-body p:last-child { margin-bottom: 0; }
    .pr-thread-body code { background: var(--vscode-textCodeBlock-background, rgba(255,255,255,0.1)); padding: 1px 4px; border-radius: 3px; font-family: var(--vscode-editor-font-family); font-size: 12px; }
    .pr-thread-body pre { background: var(--vscode-textCodeBlock-background, rgba(255,255,255,0.1)); padding: 8px; border-radius: 4px; overflow-x: auto; margin: 0.4em 0; }
    .pr-thread-body pre code { background: none; padding: 0; }
    .pr-thread-footer { margin-top: 8px; }
    .pr-reply-btn {
      background: none;
      border: 1px solid var(--vscode-widget-border, rgba(255,255,255,0.2));
      color: var(--vscode-editor-foreground);
      padding: 3px 10px; border-radius: 4px; cursor: pointer; font-size: 12px;
    }
    .pr-reply-btn:hover { background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.05)); }
    .mermaid { margin: 1em 0; }
    .pr-front-matter {
      background: var(--vscode-textBlockQuote-background, rgba(127,127,127,0.1));
      border-left: 3px solid var(--vscode-textBlockQuote-border, rgba(127,127,127,0.5));
      border-radius: 0 4px 4px 0;
      padding: 8px 12px; margin-bottom: 1em; font-size: 12px;
    }
    .pr-front-matter table { border-collapse: collapse; }
    .pr-front-matter table td { border: none; padding: 1px 8px 1px 0; vertical-align: top; }
    .fm-key { color: var(--vscode-symbolIcon-keywordForeground, #569cd6); font-weight: 600; white-space: nowrap; }
    .fm-val { color: var(--vscode-foreground, inherit); opacity: 0.85; }
    .pr-add-btn {
      position: fixed;
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff);
      border: none; border-radius: 4px;
      padding: 4px 10px; font-size: 12px; cursor: pointer;
      z-index: 200; box-shadow: 0 2px 6px rgba(0,0,0,0.3);
    }
    .pr-add-btn:hover { opacity: 0.9; }
    .pr-add-btn--snap {
      background: var(--vscode-statusBarItem-warningBackground, #854800);
      color: var(--vscode-statusBarItem-warningForeground, #fff);
    }
    .pr-context-menu {
      position: fixed;
      background: var(--vscode-menu-background, #2d2d2d);
      border: 1px solid var(--vscode-menu-border, rgba(255,255,255,0.2));
      border-radius: 4px; padding: 4px 0;
      z-index: 300; min-width: 140px; box-shadow: 0 2px 8px rgba(0,0,0,0.4);
    }
    .pr-context-item {
      padding: 6px 14px; font-size: 13px; cursor: pointer;
    }
    .pr-context-item:hover {
      background: var(--vscode-menu-selectionBackground, #094771);
      color: var(--vscode-menu-selectionForeground, #fff);
    }
    .pr-compose {
      border: 1px solid var(--vscode-focusBorder, #007acc);
      border-radius: 4px; padding: 8px; margin: 6px 0;
      background: var(--vscode-input-background, rgba(255,255,255,0.05));
      clear: both;
    }
    .pr-compose textarea {
      width: 100%; min-height: 72px;
      background: var(--vscode-input-background, transparent);
      color: var(--vscode-input-foreground, inherit);
      border: 1px solid var(--vscode-input-border, rgba(255,255,255,0.2));
      border-radius: 3px; padding: 6px;
      font-family: var(--vscode-font-family); font-size: 13px;
      resize: vertical; box-sizing: border-box;
    }
    .pr-compose textarea:focus { outline: 1px solid var(--vscode-focusBorder, #007acc); }
    .pr-compose-actions { display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap; align-items: center; }
    .pr-compose-actions button {
      padding: 4px 12px; border-radius: 4px; font-size: 12px; cursor: pointer; border: none;
    }
    .pr-btn-primary {
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff);
    }
    .pr-btn-primary:hover { opacity: 0.9; }
    .pr-btn-primary:disabled { opacity: 0.5; cursor: default; }
    .pr-btn-secondary {
      background: var(--vscode-button-secondaryBackground, rgba(255,255,255,0.1));
      color: var(--vscode-button-secondaryForeground, inherit);
      border: 1px solid var(--vscode-widget-border, rgba(255,255,255,0.2)) !important;
    }
    .pr-btn-secondary:hover { opacity: 0.9; }
    .pr-btn-secondary:disabled { opacity: 0.5; cursor: default; }
    .pr-compose-error { color: var(--vscode-errorForeground, #f48771); font-size: 12px; margin-top: 4px; display: none; }
    .pr-draft-badge {
      display: inline-flex; align-items: center; gap: 8px;
      background: var(--vscode-badge-background, #4d4d4d);
      color: var(--vscode-badge-foreground, #fff);
      border-radius: 12px; padding: 4px 12px; font-size: 12px;
    }
    .pr-draft-submit {
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff);
      border: none; border-radius: 4px; padding: 3px 10px; font-size: 12px; cursor: pointer;
    }
    .pr-draft-submit:hover { opacity: 0.9; }
    .pr-draft-error { color: var(--vscode-errorForeground, #f48771); font-size: 12px; margin-left: 8px; display: none; }
    .pr-toast {
      position: fixed; bottom: 20px; right: 20px;
      background: var(--vscode-errorForeground, #f48771); color: #fff;
      padding: 8px 16px; border-radius: 4px; font-size: 13px;
      z-index: 999; box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    }
    .pr-bubble.pr-resolved {
      opacity: 0.55;
      background: var(--vscode-disabledForeground, #6e6e6e);
    }
    .pr-thread-resolved-banner {
      font-size: 12px;
      color: var(--vscode-gitDecoration-ignoredResourceForeground, #8a8a8a);
      margin-bottom: 8px;
      font-style: italic;
    }
    .pr-thread-outdated-label {
      font-size: 12px;
      color: var(--vscode-gitDecoration-ignoredResourceForeground, #8a8a8a);
      margin-bottom: 4px;
      font-style: italic;
    }
    .pr-thread-item { position: relative; }
    .pr-dot-menu-btn {
      position: absolute; top: 4px; right: 4px;
      background: none; border: none;
      color: var(--vscode-editor-foreground); cursor: pointer;
      padding: 2px 6px; border-radius: 3px;
      font-size: 14px; line-height: 1; opacity: 0;
    }
    .pr-thread-item:hover .pr-dot-menu-btn { opacity: 0.7; }
    .pr-dot-menu-btn:hover { opacity: 1 !important; background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.05)); }
    .pr-dot-menu {
      position: absolute; top: 24px; right: 4px;
      background: var(--vscode-menu-background, #2d2d2d);
      border: 1px solid var(--vscode-menu-border, rgba(255,255,255,0.2));
      border-radius: 4px; padding: 4px 0; z-index: 400;
      min-width: 100px; box-shadow: 0 2px 8px rgba(0,0,0,0.4);
    }
    .pr-dot-menu-item {
      padding: 5px 12px; font-size: 12px; cursor: pointer; white-space: nowrap;
    }
    .pr-dot-menu-item:hover {
      background: var(--vscode-menu-selectionBackground, #094771);
      color: var(--vscode-menu-selectionForeground, #fff);
    }
    .pr-dot-menu-item.pr-delete-item { color: var(--vscode-errorForeground, #f48771); }
    .pr-delete-confirm { font-size: 12px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .pr-btn-danger {
      background: var(--vscode-errorForeground, #f48771); color: #fff;
      border: none; border-radius: 4px; padding: 3px 10px; font-size: 12px; cursor: pointer;
    }
    .pr-btn-danger:hover { opacity: 0.9; }
    .pr-btn-danger:disabled { opacity: 0.5; cursor: default; }
    .pr-resolve-btn {
      background: none;
      border: 1px solid var(--vscode-widget-border, rgba(255,255,255,0.2));
      color: var(--vscode-editor-foreground);
      padding: 3px 10px; border-radius: 4px; cursor: pointer; font-size: 12px;
    }
    .pr-resolve-btn:hover { background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.05)); }
    .pr-resolve-btn:disabled { opacity: 0.5; cursor: default; }
    .pr-nav-strip {
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 100%;
    }
    .pr-nav-left {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .pr-nav-right {
      display: flex;
      align-items: center;
      gap: 5px;
    }
    .pr-nav-btn {
      background: rgba(255,255,255,0.08);
      border: none;
      color: var(--vscode-editor-foreground);
      border-radius: 3px;
      padding: 1px 6px;
      font-size: 11px;
      cursor: pointer;
      line-height: 1.4;
    }
    .pr-nav-btn:hover { background: rgba(255,255,255,0.15); }
    .pr-nav-btn:disabled { opacity: 0.4; cursor: default; }
    .pr-header-left { order: -1; display: flex; align-items: center; gap: 4px; margin-right: auto; }
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
    [data-tooltip] { position: relative; }
    [data-tooltip]::after {
      content: attr(data-tooltip);
      position: absolute;
      top: calc(100% + 5px);
      left: 50%;
      transform: translateX(-50%);
      background: var(--vscode-editorHoverWidget-background, #252526);
      color: var(--vscode-editorHoverWidget-foreground, #cccccc);
      border: 1px solid var(--vscode-editorHoverWidget-border, rgba(255,255,255,0.15));
      border-radius: 3px;
      padding: 3px 8px;
      font-size: 11px;
      white-space: nowrap;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.15s;
      z-index: 1000;
    }
    [data-tooltip]:hover::after { opacity: 1; }
    .pr-nav-btn--action {
      background: var(--vscode-badge-background, #4d4d4d);
      color: var(--vscode-badge-foreground, #fff);
      border-radius: 10px;
      padding: 2px 8px;
    }
    .pr-nav-btn--action:hover { opacity: 0.85; background: var(--vscode-badge-background, #4d4d4d); }
    .pr-nav-counter {
      opacity: 0.6;
      font-size: 11px;
      min-width: 36px;
      text-align: center;
    }
    @keyframes pr-nav-highlight {
      0%   { outline: 2px solid var(--vscode-focusBorder, #007acc); }
      100% { outline: 2px solid transparent; }
    }
    .pr-nav-highlight {
      animation: pr-nav-highlight 600ms ease-out forwards;
    }
    .pr-table-thread-row td { border: none !important; padding: 0 !important; }
    .pr-bubble-cell {
      width: 1px;
      white-space: nowrap;
      padding: 2px 6px !important;
      vertical-align: middle;
      border: none !important;
    }
    .pr-bubble-cell .pr-bubble { float: none; margin-left: 0; }
    .pr-content table {
      border-collapse: collapse;
      border-spacing: 0;
      display: block;
      overflow: auto;
      width: max-content;
      max-width: 100%;
      margin: 1em 0;
    }
    .pr-content th,
    .pr-content td {
      border: 1px solid #d0d7de;
      padding: 6px 13px;
    }
    .pr-content tr:nth-child(2n) {
      background-color: #f6f8fa;
    }
    .pr-content thead tr {
      background-color: transparent;
    }
    body.vscode-dark .pr-content th,
    body.vscode-dark .pr-content td {
      border-color: #30363d;
    }
    body.vscode-dark .pr-content tr:nth-child(2n) {
      background-color: #161b22;
    }
    body.vscode-high-contrast .pr-content th,
    body.vscode-high-contrast .pr-content td {
      border-color: #30363d;
    }
    body.vscode-high-contrast .pr-content tr:nth-child(2n) {
      background-color: #161b22;
    }
    .pr-file-select {
      font-size: 12px;
      background: var(--vscode-dropdown-background, #3c3c3c);
      color: var(--vscode-dropdown-foreground, #cccccc);
      border: 1px solid var(--vscode-dropdown-border, rgba(255,255,255,0.1));
      border-radius: 3px;
      padding: 2px 6px;
      flex: 0 0 auto;
      max-width: 220px;
      cursor: pointer;
    }
    .pr-file-select:focus { outline: 1px solid var(--vscode-focusBorder, #007acc); }
    .pr-popover {
      background: var(--vscode-editorWidget-background, #252526);
      border: 1px solid var(--vscode-editorWidget-border, rgba(255,255,255,0.18));
      border-radius: 6px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.4);
      max-width: 360px;
      min-width: 240px;
      max-height: 60vh;
      display: flex;
      flex-direction: column;
    }
    .pr-popover-drag {
      height: 14px;
      border-radius: 6px 6px 0 0;
      background: var(--vscode-editorWidget-border, rgba(128,128,128,0.15));
      cursor: grab;
      display: flex;
      align-items: center;
      justify-content: center;
      user-select: none;
      flex-shrink: 0;
    }
    .pr-popover-drag::before {
      content: '···';
      letter-spacing: 2px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground, #888);
    }
    .pr-popover-drag:active { cursor: grabbing; }
    .pr-popover-body {
      overflow-y: auto;
      padding: 10px 12px;
    }
    .pr-popover-arrow--left,
    .pr-popover-arrow--right {
      position: absolute;
      width: 0;
      height: 0;
    }
    .pr-popover-arrow--left {
      left: -6px;
      border-top: 5px solid transparent;
      border-bottom: 5px solid transparent;
      border-right: 6px solid var(--vscode-editorWidget-border, rgba(255,255,255,0.18));
    }
    .pr-popover-arrow--right {
      right: -6px;
      border-top: 5px solid transparent;
      border-bottom: 5px solid transparent;
      border-left: 6px solid var(--vscode-editorWidget-border, rgba(255,255,255,0.18));
    }
  </style>
</head>
<body>
  <div id="review-header"></div>
  <div id="content" class="pr-content"><p>Loading&#x2026;</p></div>
  <script nonce="${nonce}" src="${mermaidUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
