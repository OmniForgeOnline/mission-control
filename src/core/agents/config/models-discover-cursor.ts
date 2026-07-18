import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { DiscoveredModel } from "./usage-providers.ts";
import { buildLaunchEnv } from "../runtime/launch.ts";

const execFileAsync = promisify(execFile);

/**
 * Parse `cursor-agent --list-models` text output.
 * Lines look like: `auto - Auto (current, default)` or `composer-2.5 - Composer 2.5`.
 */
export function mapCursorModels(stdout: string): DiscoveredModel[] {
  const models: DiscoveredModel[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^available models$/i.test(trimmed)) continue;
    const match = /^([a-zA-Z0-9][a-zA-Z0-9._-]*)\s+-\s+(.+)$/.exec(trimmed);
    if (!match) continue;
    const id = match[1]!;
    let displayName = match[2]!.trim();
    displayName = displayName.replace(/\s*\([^)]*\)\s*$/, "").trim() || id;
    if (!models.some((entry) => entry.id === id)) {
      models.push({ id, displayName });
    }
  }
  return models;
}

/** Run `cursor-agent --list-models` (or whatever resolved binary) and parse the listing. */
export async function fetchCursorModels(command: string, cwd: string): Promise<DiscoveredModel[]> {
  const { stdout, stderr } = await execFileAsync(command, ["--list-models"], {
    cwd,
    env: buildLaunchEnv(command),
    timeout: 45_000,
    maxBuffer: 4 * 1024 * 1024
  });
  const text = String(stdout || "");
  const models = mapCursorModels(text);
  if (models.length === 0) {
    const err = String(stderr || "").trim() || text.trim() || "No models returned.";
    throw new Error(err.startsWith("Failed") ? err : `Cursor model list failed: ${err}`);
  }
  return models;
}

export function cursorPoolIdForModel(modelId: string): string {
  return `cursor-${modelId}`;
}
