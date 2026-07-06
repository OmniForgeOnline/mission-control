import type { ExtensionRegistry, ToolExtension } from "./types.ts";

export function normalizeExtension(raw: unknown): ToolExtension {
  if (!raw || typeof raw !== "object") {
    throw new Error("Extension entry must be an object.");
  }
  const record = raw as Record<string, unknown>;
  const id = typeof record["id"] === "string" ? record["id"].trim() : "";
  if (!id) throw new Error("Extension id is required.");
  const toolId = typeof record["toolId"] === "string" ? record["toolId"].trim() : "";
  if (!toolId) throw new Error(`Extension "${id}" requires toolId.`);
  const kind = record["kind"];
  if (kind !== "plugin" && kind !== "skill" && kind !== "subagent" && kind !== "mcp") {
    throw new Error(`Extension "${id}" has invalid kind.`);
  }
  const displayName =
    typeof record["displayName"] === "string" && record["displayName"].trim()
      ? record["displayName"].trim()
      : id;
  const source = typeof record["source"] === "string" ? record["source"].trim() : id;
  const detectedFrom = record["detectedFrom"] === "manual" ? "manual" : "disk";
  return {
    id,
    toolId: toolId as ToolExtension["toolId"],
    kind,
    displayName,
    source,
    detectedFrom,
    defaultEnabled: record["defaultEnabled"] !== false
  };
}

export function normalizeRegistry(raw: unknown): ExtensionRegistry {
  if (!raw || typeof raw !== "object") return { extensions: [] };
  const record = raw as Record<string, unknown>;
  const extensions = Array.isArray(record["extensions"])
    ? record["extensions"].map(normalizeExtension)
    : [];
  const lastDiscoveredAt =
    typeof record["lastDiscoveredAt"] === "string" ? record["lastDiscoveredAt"] : undefined;
  return {
    extensions,
    ...(lastDiscoveredAt ? { lastDiscoveredAt } : {})
  };
}
