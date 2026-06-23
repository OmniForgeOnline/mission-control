export function requestRefresh(): void {
  document.dispatchEvent(new CustomEvent("harness:refresh"));
}

export function requestRefreshRender(): void {
  document.dispatchEvent(new CustomEvent("harness:refresh-render"));
}