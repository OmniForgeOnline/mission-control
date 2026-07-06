import type { ToolExtension } from "./types.ts";

export interface CodexExtensionCliOverride {
  key: string;
  value: string;
}

/** Build Codex -c TOML overrides for plugin and skill enablement. */
export function buildCodexExtensionOverrides(
  allEntries: ToolExtension[],
  enabledIds: string[]
): CodexExtensionCliOverride[] {
  const enabled = new Set(enabledIds);
  const overrides: CodexExtensionCliOverride[] = [];

  for (const entry of allEntries) {
    if (entry.kind !== "plugin") continue;
    overrides.push({
      key: `plugins.${entry.source}.enabled`,
      value: String(enabled.has(entry.id))
    });
  }

  const skillEntries = allEntries.filter((entry) => entry.kind === "skill");
  if (skillEntries.length > 0) {
    const items = skillEntries
      .map(
        (entry) =>
          `{ path = ${JSON.stringify(entry.source)}, enabled = ${enabled.has(entry.id) ? "true" : "false"} }`
      )
      .join(", ");
    overrides.push({ key: "skills.config", value: `[${items}]` });
  }

  return overrides;
}

export function codexOverridesToCliArgs(overrides: CodexExtensionCliOverride[]): string[] {
  const args: string[] = [];
  for (const override of overrides) {
    args.push("-c", `${override.key}=${override.value}`);
  }
  return args;
}
