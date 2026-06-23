/** Shared dialog lifecycle helpers for reliable backdrop dismiss and stacking. */

const DISMISS_KEY = "dialogDismiss";

export function bindDialogDismiss(dlg: HTMLDialogElement): void {
  const prior = (dlg as HTMLDialogElement & { [DISMISS_KEY]?: (e: MouseEvent) => void })[DISMISS_KEY];
  if (prior) dlg.removeEventListener("click", prior);

  const onBackdrop = (event: MouseEvent): void => {
    if (event.target === dlg) dlg.close();
  };
  (dlg as HTMLDialogElement & { [DISMISS_KEY]: (e: MouseEvent) => void })[DISMISS_KEY] = onBackdrop;
  dlg.addEventListener("click", onBackdrop);
}

export function openDialogs(): HTMLDialogElement[] {
  return [...document.querySelectorAll<HTMLDialogElement>("dialog[open]")];
}

export function hasOpenOverlay(): boolean {
  return openDialogs().length > 0;
}

/** Close the topmost open dialog (last in document order). */
export function dismissTopmostOverlay(): boolean {
  const open = openDialogs();
  const top = open[open.length - 1];
  if (!top) return false;
  top.close();
  return true;
}