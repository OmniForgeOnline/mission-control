import { buildMemoryIndex, summarizeMemoryIndex } from "../../memory/index.ts";
import type { AutonomyJobContext } from "../registry.ts";
import type { AutonomyRunResult } from "../job-types.ts";

/**
 * Rebuild the search index for a single project's memory (wiki pages, tasks,
 * runs, run logs, and target files). Scoped per project — there is no global
 * index after memory was re-homed under each project dir.
 */
export async function runProjectMemoryIndexRefresh(
  root: string,
  context?: AutonomyJobContext
): Promise<AutonomyRunResult> {
  const project = context?.project;
  if (!project) throw new Error("Missing project context.");

  const index = await buildMemoryIndex(root, project.id);
  return {
    jobId: "memory-index-refresh",
    status: "completed",
    summary: `Refreshed ${project.name} index: ${summarizeMemoryIndex(index)}.`,
    proposalsCreated: 0
  };
}
