const STORAGE_KEY = "harness:palette-recent";
const MAX_RECENT = 8;

export function recordPaletteRecent(id: string): void {
  if (!id) return;
  const existing = getRecentPaletteIds().filter((entry) => entry !== id);
  const next = [id, ...existing].slice(0, MAX_RECENT);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore quota / private mode
  }
}

export function getRecentPaletteIds(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return [];
  }
}