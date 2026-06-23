export function userIsEditing(): boolean {
  const active = document.activeElement;
  if (!active) return false;
  if (
    active instanceof HTMLInputElement ||
    active instanceof HTMLTextAreaElement ||
    active instanceof HTMLSelectElement ||
    (active instanceof HTMLElement && active.isContentEditable)
  ) {
    return true;
  }
  return false;
}