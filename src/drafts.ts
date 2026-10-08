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
