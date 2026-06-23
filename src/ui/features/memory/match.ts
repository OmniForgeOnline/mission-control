import type { MemoryPage } from "@ui/app/types.js";

const MEMORY_INDEX_ID_PREFIX = "memory:";
const MEMORY_INDEX_PATH_PREFIX = "memory/pages/";

/**
 * Recover a memory slug from an index-search hit. `/api/memory/index/search`
 * returns memory documents as `{ id: "memory:<slug>", path: "memory/pages/<slug>.md" }`
 * with no `slug`, so neither field is a valid open/delete key as-is. Prefer the
 * `id` (the exact slug the backend indexed) and fall back to stripping the
 * indexed path. Returns "" when no slug can be recovered.
 */
function slugFromIndexHit(page: Pick<MemoryPage, "id" | "path">): string {
  if (page.id?.startsWith(MEMORY_INDEX_ID_PREFIX)) {
    return page.id.slice(MEMORY_INDEX_ID_PREFIX.length);
  }
  if (page.path?.startsWith(MEMORY_INDEX_PATH_PREFIX) && page.path.endsWith(".md")) {
    return page.path.slice(MEMORY_INDEX_PATH_PREFIX.length, -".md".length);
  }
  return "";
}

/**
 * Identity string for a memory page: the slug when present, the recovered slug
 * for memory index-search hits, otherwise the indexed path, falling back to
 * empty. This is the key used for open/delete API calls (valid only when
 * {@link isMemoryPage} is true) and for matching rows during local
 * search-result updates.
 */
export function pageSlug(page: Pick<MemoryPage, "slug" | "path" | "id" | "sourceType">): string {
  if (page.slug) return page.slug;
  if (page.sourceType === "memory") return slugFromIndexHit(page);
  return page.path ?? "";
}

/**
 * Whether a row is backed by an actual memory page that can be opened or
 * deleted through `/api/memory/pages`. Default-list pages carry a `slug`;
 * memory index-search hits are identified by `sourceType === "memory"`. Other
 * index sources (tasks, runs, files) have no memory page, so their rows must
 * hide the open/delete affordance.
 */
export function isMemoryPage(
  page: Pick<MemoryPage, "slug" | "sourceType">
): boolean {
  return Boolean(page.slug) || page.sourceType === "memory";
}

/**
 * Drop the page whose `pageSlug` matches `slug` from a list. Used to update
 * local search-result state immediately after a delete, since a
 * `harness:refresh` reloads shared `memoryPages` but not the panel's local
 * search results.
 */
export function withoutPage(pages: MemoryPage[], slug: string): MemoryPage[] {
  return pages.filter((page) => pageSlug(page) !== slug);
}

