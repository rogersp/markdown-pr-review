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
