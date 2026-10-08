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
  // GitHub does not treat a backslash as a separator, but Windows path.join would,
  // letting a backslash '..' slip past the check below.
  if (linkPath.includes('\\')) return { kind: 'invalid', reason: `Unsupported link: ${href}` };

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

// Cmd/Ctrl-click and middle-click invert the configured default, as in a browser.
export function opensNewPanel(setting: string | undefined, modifier: boolean): boolean {
  return (setting === 'newPanel') !== modifier;
}
