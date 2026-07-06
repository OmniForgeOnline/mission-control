import { writeFile } from "node:fs/promises";
import path from "node:path";

import { ensureDir } from "../../infra/fs.ts";
import type { ToolExtension } from "./types.ts";

/** Write Kiro hook enablement into the worktree's .kiro/hooks/ directory. */
export async function writeKiroExtensionConfig(opts: {
  cwd: string;
  extensions: ToolExtension[];
  enabledIds: string[];
}): Promise<string | undefined> {
  const kiroHooks = opts.extensions.filter((entry) => entry.kind === "subagent");
  if (kiroHooks.length === 0) return undefined;

  const enabled = new Set(opts.enabledIds);
  const dir = path.join(opts.cwd, ".kiro", "hooks");
  await ensureDir(dir);
  const manifestPath = path.join(dir, "mission-control-extensions.json");
  await writeFile(
    manifestPath,
    JSON.stringify(
      {
        enabled: kiroHooks.filter((entry) => enabled.has(entry.id)).map((entry) => entry.source)
      },
      null,
      2
    ),
    "utf8"
  );
  return manifestPath;
}
