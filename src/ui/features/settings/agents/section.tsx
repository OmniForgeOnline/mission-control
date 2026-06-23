import type { HarnessSettings } from "../../../../core/settings.ts";
import { ui } from "@ui/app/state.js";

const FALLBACK_AGENT_OPTIONS = ["grok", "claude", "codex", "opencode"] as const;

function agentSelectOptions(): Array<{ value: string; label: string }> {
  const agents = ui.data?.agents;
  if (agents?.length) {
    return agents.map((agent) => ({ value: agent.id, label: agent.displayName }));
  }
  return FALLBACK_AGENT_OPTIONS.map((agent) => ({ value: agent, label: agent }));
}

/** Compact default-agent picker rendered in the Agents pane header. */
export function DefaultAgentControl({
  settings,
  applyPatch
}: {
  settings: HarnessSettings;
  applyPatch: (patch: Partial<HarnessSettings>, silent?: boolean) => Promise<void>;
}) {
  return (
    <label class="settings-head-control" title="Default agent for every automated step unless a per-stage override is set">
      <span class="settings-head-control-label">Default</span>
      <select
        class="select settings-control"
        name="defaultAgent"
        value={settings.defaultAgent}
        onChange={(e) =>
          void applyPatch({
            defaultAgent: (e.currentTarget as HTMLSelectElement).value as HarnessSettings["defaultAgent"]
          })
        }
      >
        {agentSelectOptions().map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </label>
  );
}
