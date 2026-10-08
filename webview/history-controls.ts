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
