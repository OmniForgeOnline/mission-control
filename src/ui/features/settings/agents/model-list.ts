import type { ModelPoolConfig } from "../../../../core/agents/config/types.ts";

/** How many models to show inline on the tool card before "View all". */
export const INLINE_MODEL_PREVIEW = 5;

/** No-arg "default" pool — tool uses its own configured model. */
export function isDefaultPool(pool: ModelPoolConfig): boolean {
  return pool.modelArgs.length === 0;
}

/**
 * Default pool always first; then enabled, then display name.
 * Stable for card preview + modal.
 */
export function sortPoolsForDisplay(pools: ModelPoolConfig[]): ModelPoolConfig[] {
  return [...pools].sort((a, b) => {
    const aDefault = isDefaultPool(a);
    const bDefault = isDefaultPool(b);
    if (aDefault !== bDefault) return aDefault ? -1 : 1;
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return a.displayName.localeCompare(b.displayName);
  });
}
