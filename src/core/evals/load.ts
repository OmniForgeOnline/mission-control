import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { BUNDLED_WORKFLOW_IDS } from "../workflows/types.ts";
import { bundledEvalCorpusDir } from "./paths.ts";
import { validateEvalCase } from "./schema.ts";
import type { EvalCorpus, EvalValidationResult, LoadedEvalCase } from "./types.ts";

const WORKFLOW_IDS = new Set<string>(BUNDLED_WORKFLOW_IDS);

async function walkJsonFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkJsonFiles(fullPath)));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(fullPath);
    }
  }
  return files.sort();
}

export async function loadEvalCaseFile(
  filePath: string,
  workflowIds: ReadonlySet<string> = WORKFLOW_IDS
): Promise<EvalValidationResult & { path: string }> {
  const raw = await readFile(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid JSON";
    return { ok: false, errors: [`JSON parse error: ${message}`], path: filePath };
  }
  const validated = validateEvalCase(parsed, workflowIds);
  return { ...validated, path: filePath };
}

export async function loadEvalCorpus(options?: {
  root?: string;
  version?: string;
}): Promise<EvalCorpus> {
  const version = options?.version ?? "v1";
  const root = options?.root ?? bundledEvalCorpusDir(version);
  const files = await walkJsonFiles(root);
  const cases: LoadedEvalCase[] = [];
  const seenIds = new Map<string, string>();

  for (const filePath of files) {
    const loaded = await loadEvalCaseFile(filePath);
    if (loaded.ok) {
      const priorPath = seenIds.get(loaded.case.id);
      if (priorPath) {
        cases.push({
          path: filePath,
          case: null,
          errors: [`Duplicate case id "${loaded.case.id}" (also declared in ${priorPath}).`]
        });
        continue;
      }
      seenIds.set(loaded.case.id, filePath);
      cases.push({ path: filePath, case: loaded.case, errors: [] });
    } else {
      cases.push({ path: filePath, case: null, errors: loaded.errors });
    }
  }

  return {
    version,
    root,
    cases
  };
}
