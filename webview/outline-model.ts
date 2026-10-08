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
