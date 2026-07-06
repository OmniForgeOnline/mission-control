import { detectBuildConfigs, detectManifestCommands, detectMarkers } from "./intel-markers.ts";
import { collectCiCommands, collectDocCommands } from "./intel-docs-ci.ts";

/**
 * Quality-gate categories the system reasons about. Intentionally tool-agnostic:
 * a category says *what* a command does, never *which* toolchain runs it. The
 * per-project intel layer maps concrete repo evidence onto these categories; it
 * never assumes a specific stack.
 */
export type GateCategory =
  | "lint"
  | "test"
  | "typecheck"
  | "build"
  | "format"
  | "security"
  | "other";

/** Coarse stack inferred from a marker file. Diagnostic only; never gates behavior. */
export type ProjectStack =
  | "python"
  | "node"
  | "rust"
  | "go"
  | "ruby"
  | "jvm"
  | "dotnet"
  | "make";

/** A recognized repo marker (manifest, lockfile, or build-automation file). */
export interface ProjectMarker {
  /** Repo-relative path, e.g. "pyproject.toml". */
  path: string;
  stack?: ProjectStack;
  /** What this marker tells us, e.g. "package manifest", "lockfile". */
  purpose: string;
}

/** A command backed by concrete repo evidence (never a generic guess). */
export interface DetectedCommand {
  command: string;
  category: GateCategory;
  /** Where this command came from, e.g. "package.json script `test`". */
  source: string;
}

/** Commands excerpted from human-authored docs (README, CONTRIBUTING, ...). */
export interface DocExcerpt {
  path: string;
  commands: string[];
}

/** Structured, tool-agnostic intel gathered read-only from a repo. */
export interface ProjectIntel {
  repoPath: string;
  markers: ProjectMarker[];
  /** Evidence-backed commands found in manifests / Makefile / Python tooling. */
  commands: DetectedCommand[];
  /** Shell commands mentioned in docs (lower confidence; agent verifies). */
  docs: DocExcerpt[];
  /** Commands run by CI workflows. */
  ci: DetectedCommand[];
  /** Build-config files present (generic existence check; the agent interprets). */
  buildConfigs: string[];
  /** Human-readable bullets summarizing the intel for the agent prompt. */
  summary: string[];
}

/** Dedupe by category+command, preserving first-occurrence order. */
function dedupeCommands(commands: DetectedCommand[]): DetectedCommand[] {
  const seen = new Set<string>();
  const out: DetectedCommand[] = [];
  for (const cmd of commands) {
    const key = `${cmd.category}:${cmd.command}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cmd);
  }
  return out;
}

function buildSummary(intel: Omit<ProjectIntel, "summary">): string[] {
  const lines: string[] = [];
  if (intel.buildConfigs.length) {
    lines.push(`Build config files detected: ${intel.buildConfigs.join(", ")}.`);
  }
  const byStack = new Map<ProjectStack, string[]>();
  for (const marker of intel.markers) {
    if (!marker.stack) continue;
    const list = byStack.get(marker.stack) ?? [];
    list.push(marker.path);
    byStack.set(marker.stack, list);
  }
  for (const [stack, files] of byStack) {
    lines.push(`${stack} project markers: ${[...new Set(files)].join(", ")}.`);
  }
  const byCat = new Map<GateCategory, string[]>();
  for (const cmd of intel.commands) {
    const list = byCat.get(cmd.category) ?? [];
    list.push(cmd.command);
    byCat.set(cmd.category, list);
  }
  for (const [category, cmds] of byCat) {
    lines.push(`${category}: ${[...new Set(cmds)].join(", ")} (from manifests/Makefile).`);
  }
  for (const doc of intel.docs) {
    lines.push(`docs (${doc.path}) mention: ${doc.commands.map((c) => `\`${c}\``).join(", ")}.`);
  }
  if (intel.ci.length) {
    lines.push(`CI runs: ${[...new Set(intel.ci.map((c) => c.command))].join(", ")}.`);
  }
  return lines;
}

/**
 * Gather structured, tool-agnostic intel from a repo, read-only. Covers standard
 * project markers (pyproject.toml, package.json, Makefile, lockfiles, ...), the
 * automation each declares (Make targets, package scripts, Python tooling), and
 * build/test/lint hints from docs and CI. Output is evidence, never a gate.
 */
export async function gatherProjectIntel(repoPath: string): Promise<ProjectIntel> {
  const { markers, lockfiles } = await detectMarkers(repoPath);
  const commands = await detectManifestCommands(repoPath, lockfiles);
  const docs = await collectDocCommands(repoPath);
  const ci = await collectCiCommands(repoPath);
  const buildConfigs = await detectBuildConfigs(repoPath);

  const base: Omit<ProjectIntel, "summary"> = {
    repoPath,
    markers,
    commands: dedupeCommands(commands),
    docs,
    ci,
    buildConfigs
  };
  return { ...base, summary: buildSummary(base) };
}
