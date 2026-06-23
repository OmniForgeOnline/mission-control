// Pure presentational helpers for the step-scoped Agent / Effort controls.
// Kept free of Preact so they can be unit-tested in isolation. The data model
// carries no brand colors, so the agent palette lives here as a UI concern.

export interface AgentVisual {
  /** Swatch background color. */
  color: string;
  /** Single-glyph label drawn inside the swatch. */
  initial: string;
}

const KNOWN_AGENT_VISUALS: Record<string, AgentVisual> = {
  codex: { color: "#10a37f", initial: "C" },
  claude: { color: "#d97757", initial: "C" },
  grok: { color: "#1d9bf0", initial: "G" },
  opencode: { color: "var(--accent)", initial: "O" }
};

/**
 * Resolve a swatch color + initial for an agent id. Known agents get their
 * brand color; unknown agents fall back to a neutral swatch with an initial
 * derived from the display name (or id).
 */
export function agentVisual(id: string | null | undefined, displayName?: string): AgentVisual {
  if (id && KNOWN_AGENT_VISUALS[id]) {
    return KNOWN_AGENT_VISUALS[id];
  }
  const source = (displayName ?? id ?? "").trim();
  const initial = source ? source.charAt(0).toUpperCase() : "·";
  return { color: "var(--ink-faint)", initial };
}

export interface EffortBar {
  /** Bar height in px. */
  height: number;
  /** Whether this bar is lit (part of the selected level). */
  on: boolean;
}

const MIN_BAR = 5;
const MAX_BAR = 13;

/**
 * Build the segmented-bar spec for an effort indicator. `levels` is the ordered
 * list the agent supports (e.g. ["low","medium","high"]); `current` is the
 * selected level. Bars up to and including the current level are lit. An
 * unknown/empty current level lights none. Heights ramp from MIN_BAR to MAX_BAR.
 */
export function effortBarSpec(levels: readonly string[], current: string | null | undefined): EffortBar[] {
  const count = Math.max(levels.length, 1);
  const selectedIdx = current ? levels.indexOf(current) : -1;
  const step = count > 1 ? (MAX_BAR - MIN_BAR) / (count - 1) : 0;
  return Array.from({ length: count }, (_, i) => ({
    height: Math.round(MIN_BAR + step * i),
    on: selectedIdx >= 0 && i <= selectedIdx
  }));
}
