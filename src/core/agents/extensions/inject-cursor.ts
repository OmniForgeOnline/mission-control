import { writeFile } from "node:fs/promises";
import path from "node:path";

import { ensureDir } from "../../infra/fs.ts";
import type { ToolExtension } from "./types.ts";

/** Write the Cursor extension scoping manifest into the worktree. */
export async function writeCursorExtensionConfig(opts: {
  cwd: string;
  extensions: ToolExtension[];
  enabledIds: string[];
}): Promise<string | undefined> {
  const entries = opts.extensions.filter((entry) => entry.kind === "skill" || entry.kind === "plugin");
  if (entries.length === 0) return undefined;

  const enabled = new Set(opts.enabledIds);
  const dir = path.join(opts.cwd, ".cursor");
  await ensureDir(dir);
  const manifestPath = path.join(dir, "mission-control-extensions.json");
  await writeFile(
    manifestPath,
    JSON.stringify(
      {
        enabled: entries.filter((entry) => enabled.has(entry.id)).map((entry) => entry.id)
      },
      null,
      2
    ),
    "utf8"
  );
  return manifestPath;
}
