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
