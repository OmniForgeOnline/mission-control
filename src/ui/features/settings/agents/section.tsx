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

/** Default-agent picker for the Agents settings rows. */
export function DefaultAgentSelect({
  settings,
  applyPatch
}: {
  settings: HarnessSettings;
  applyPatch: (patch: Partial<HarnessSettings>, silent?: boolean) => Promise<void>;
}) {
  return (
    <select
      class="select settings-control"
      name="defaultAgent"
      aria-label="Default agent"
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
  );
}
