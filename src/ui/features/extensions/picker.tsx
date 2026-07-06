import { useMemo } from "preact/hooks";

import type { ToolExtension } from "../../../core/agents/extensions/types.ts";

interface ExtensionPickerProps {
  selectedIds: string[];
  extensions: ToolExtension[];
  onChange: (ids: string[] | undefined) => void;
  hint?: string;
}

function sortExtensions(extensions: ToolExtension[]): ToolExtension[] {
  return [...extensions].sort((a, b) => {
    const tool = a.toolId.localeCompare(b.toolId);
    if (tool !== 0) return tool;
    return a.displayName.localeCompare(b.displayName);
  });
}

export function ExtensionPicker({ selectedIds, extensions, onChange, hint }: ExtensionPickerProps) {
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const sorted = useMemo(() => sortExtensions(extensions), [extensions]);

  function toggle(id: string): void {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    const ids = [...next];
    onChange(ids.length ? ids : undefined);
  }

  function remove(id: string): void {
    const ids = selectedIds.filter((entry) => entry !== id);
    onChange(ids.length ? ids : undefined);
  }

  return (
    <div class="extension-picker">
      <div class="extension-picker-head">
        <span class="extension-picker-title">Step extensions</span>
        <span class="extension-picker-count">
          {selectedIds.length} selected · pick any number
        </span>
      </div>
      <p class="extension-picker-hint muted">
        {hint ??
          "Enable one or more plugins/skills for this step only. Each selected extension is scoped to the agent turn; leave empty to use Settings defaults."}
      </p>

      {selectedIds.length > 0 ? (
        <ul class="extension-chips" aria-label="Selected extensions">
          {selectedIds.map((id) => {
            const entry = extensions.find((ext) => ext.id === id);
            return (
              <li key={id} class="extension-chip">
                <span class="extension-chip-label">{entry?.displayName ?? id}</span>
                <button class="extension-chip-remove" type="button" title="Remove" onClick={() => remove(id)}>
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p class="extension-picker-empty muted">No step-specific extensions — tool defaults apply.</p>
      )}

      {sorted.length === 0 ? (
        <p class="extension-picker-missing muted">
          No extensions registered yet. Open Settings → Agents, then refresh or install from a marketplace.
        </p>
      ) : (
        <ul class="extension-picker-list">
          {sorted.map((entry) => (
            <li key={entry.id}>
              <label class="extension-picker-option">
                <input
                  type="checkbox"
                  checked={selected.has(entry.id)}
                  onChange={() => toggle(entry.id)}
                />
                <span class={`extension-kind is-${entry.kind}`}>{entry.kind}</span>
                <span class="extension-picker-name">{entry.displayName}</span>
                <span class="extension-picker-tool">{entry.toolId}</span>
                <code class="extension-picker-id">{entry.id}</code>
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
