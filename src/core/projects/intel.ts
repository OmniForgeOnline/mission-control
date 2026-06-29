import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { walkDir } from "../infra/walk-dir.ts";

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
  /** Human-readable bullets summarizing the intel for the agent prompt. */
  summary: string[];
}

const MARKER_FILES: ReadonlyArray<{ file: string[]; stack?: ProjectStack; purpose: string }> = [
  { file: ["pyproject.toml"], stack: "python", purpose: "Python project manifest" },
  { file: ["setup.py"], stack: "python", purpose: "Python setup script" },
  { file: ["requirements.txt", "requirements-dev.txt"], stack: "python", purpose: "Python dependencies" },
  { file: ["package.json"], stack: "node", purpose: "Node package manifest" },
  { file: ["tsconfig.json"], stack: "node", purpose: "TypeScript config" },
  { file: ["Cargo.toml"], stack: "rust", purpose: "Rust manifest" },
  { file: ["go.mod"], stack: "go", purpose: "Go module" },
  { file: ["Gemfile"], stack: "ruby", purpose: "Ruby bundle" },
  { file: ["pom.xml"], stack: "jvm", purpose: "Maven build" },
  { file: ["build.gradle", "build.gradle.kts"], stack: "jvm", purpose: "Gradle build" },
  { file: ["Makefile", "makefile", "GNUmakefile"], stack: "make", purpose: "Make build automation" }
];

const LOCKFILES: ReadonlyArray<{ file: string; stack?: ProjectStack }> = [
  { file: "package-lock.json", stack: "node" },
  { file: "yarn.lock", stack: "node" },
  { file: "pnpm-lock.yaml", stack: "node" },
  { file: "poetry.lock", stack: "python" },
  { file: "uv.lock", stack: "python" },
  { file: "Cargo.lock", stack: "rust" },
  { file: "go.sum", stack: "go" }
];

/** Map a package/Make target name onto a gate category, if it is canonical. */
const NAME_CATEGORY: Record<string, GateCategory> = {
  lint: "lint",
  lints: "lint",
  test: "test",
  tests: "test",
  check: "test",
  checks: "test",
  typecheck: "typecheck",
  "type-check": "typecheck",
  tsc: "typecheck",
  build: "build",
  compile: "build",
  format: "format",
  fmt: "format",
  prettier: "format"
};

/** Python tools declared under `[tool.*]` and their conventional invocation. */
interface PythonTool {
  category: GateCategory;
  /** Build the command given a runner prefix (e.g. "uv run ", "" for bare). */
  invoke: (prefix: string) => string;
}
const PYTHON_TOOLS: Record<string, PythonTool> = {
  pytest: { category: "test", invoke: (p) => `${p}pytest` },
  ruff: { category: "lint", invoke: (p) => `${p}ruff check .` },
  mypy: { category: "typecheck", invoke: (p) => `${p}mypy .` },
  black: { category: "format", invoke: (p) => `${p}black .` },
  isort: { category: "format", invoke: (p) => `${p}isort .` },
  bandit: { category: "security", invoke: (p) => `${p}bandit -r .` },
  pylint: { category: "lint", invoke: (p) => `${p}pylint .` }
};

type NodePackageManager = "npm" | "yarn" | "pnpm";
type PythonRunner = "poetry" | "uv" | "hatch" | "bare";

const DOC_KEYWORDS =
  /\b(test|tests|pytest|lint|lints|ruff|eslint|biome|typecheck|type-check|mypy|tsc|build|compile|check|ci|format|prettier|black|make|npm|yarn|pnpm|cargo|gradle|mvn|go test|rake)\b/i;
const DOC_GLOB = /^(readme|contributing|develop|building|hacking)\b.*\.(md|markdown|rst|txt)$/i;

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readText(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

function categoryForName(name: string): GateCategory | undefined {
  const lower = name.toLowerCase();
  if (NAME_CATEGORY[lower]) return NAME_CATEGORY[lower];
  for (const key of ["typecheck", "type-check", "lint", "test", "build", "format"] as const) {
    if (lower.startsWith(`${key}:`) || lower.startsWith(`${key}-`)) {
      return NAME_CATEGORY[key] ?? undefined;
    }
  }
  return undefined;
}

function detectNodePackageManager(lockfiles: Set<string>): NodePackageManager {
  if (lockfiles.has("pnpm-lock.yaml")) return "pnpm";
  if (lockfiles.has("yarn.lock")) return "yarn";
  return "npm";
}

/** Build a marker, including `stack` only when known (exactOptionalPropertyTypes-safe). */
function marker(path: string, purpose: string, stack?: ProjectStack): ProjectMarker {
  return stack ? { path, stack, purpose } : { path, purpose };
}

function nodeRunPrefix(pm: NodePackageManager): string {
  if (pm === "yarn") return "yarn run";
  if (pm === "pnpm") return "pnpm run";
  return "npm run -s";
}

async function detectNodeCommands(
  repoPath: string,
  lockfiles: Set<string>
): Promise<{ commands: DetectedCommand[]; scripts: Record<string, string> } | null> {
  const raw = await readText(path.join(repoPath, "package.json"));
  if (raw === null) return null;

  let scripts: Record<string, string> = {};
  try {
    const pkg = JSON.parse(raw);
    if (pkg && typeof pkg === "object" && pkg.scripts && typeof pkg.scripts === "object") {
      scripts = pkg.scripts as Record<string, string>;
    }
  } catch {
    // Malformed package.json: no scripts detected.
  }

  const pm = detectNodePackageManager(lockfiles);
  const prefix = nodeRunPrefix(pm);
  const commands: DetectedCommand[] = [];
  for (const [name, value] of Object.entries(scripts)) {
    if (typeof value !== "string" || value.length === 0) continue;
    const category = categoryForName(name);
    if (!category) continue;
    commands.push({ command: `${prefix} ${name}`, category, source: `package.json script \`${name}\`` });
  }
  return { commands, scripts };
}

/** Detect a Python runner prefix from pyproject sections and lockfiles. */
function detectPythonRunner(pyprojectText: string | null, lockfiles: Set<string>): PythonRunner {
  if (pyprojectText?.includes("[tool.poetry]")) return "poetry";
  if (/\[tool\.hatch[.\]]/.test(pyprojectText ?? "")) return "hatch";
  if (lockfiles.has("uv.lock")) return "uv";
  return "bare";
}

function pythonRunnerPrefix(runner: PythonRunner): string {
  switch (runner) {
    case "poetry":
      return "poetry run ";
    case "uv":
      return "uv run ";
    case "hatch":
      return "hatch run ";
    default:
      return "";
  }
}

async function detectPythonCommands(
  repoPath: string,
  lockfiles: Set<string>
): Promise<DetectedCommand[] | null> {
  const pyproject = await readText(path.join(repoPath, "pyproject.toml"));
  if (pyproject === null) return null;

  const runner = detectPythonRunner(pyproject, lockfiles);
  const prefix = pythonRunnerPrefix(runner);
  const commands: DetectedCommand[] = [];
  const seen = new Set<string>();

  for (const tool of Object.keys(PYTHON_TOOLS)) {
    const section = new RegExp(`^\\[tool\\.${tool}`, "m");
    if (!section.test(pyproject)) continue;
    const key = `${tool}:${runner}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const spec = PYTHON_TOOLS[tool]!;
    commands.push({
      command: spec.invoke(prefix),
      category: spec.category,
      source: `pyproject.toml [tool.${tool}]`
    });
  }
  return commands;
}

async function detectMakefileCommands(repoPath: string): Promise<DetectedCommand[] | null> {
  const makePath = await detectMakefilePath(repoPath);
  if (!makePath) return null;
  const text = await readText(makePath);
  if (text === null) return null;

  const commands: DetectedCommand[] = [];
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    const match = line.match(/^([a-zA-Z0-9_.-]+)\s*:/);
    if (!match || !match[1]) continue;
    const target = match[1];
    const category = categoryForName(target);
    if (!category) continue;
    if (seen.has(target)) continue;
    seen.add(target);
    commands.push({ command: `make ${target}`, category, source: `Makefile target \`${target}\`` });
  }
  return commands;
}

async function detectMakefilePath(repoPath: string): Promise<string | null> {
  for (const name of ["Makefile", "makefile", "GNUmakefile"]) {
    const candidate = path.join(repoPath, name);
    if (await exists(candidate)) return candidate;
  }
  return null;
}

function cleanDocCommand(raw: string): string {
  return raw
    .replace(/^\s*[-*•]\s+/, "")
    .replace(/^\$?\s*/, "")
    .replace(/^>\s*/, "")
    .replace(/`/g, "")
    .trim();
}

async function collectDocCommands(repoPath: string): Promise<DocExcerpt[]> {
  const entries = await readdirSafe(repoPath);
  const docFiles = entries.filter((name) => DOC_GLOB.test(name)).sort();
  const excerpts: DocExcerpt[] = [];

  for (const name of docFiles) {
    const text = await readText(path.join(repoPath, name));
    if (text === null) continue;
    const commands = new Set<string>();
    let inFence = false;
    for (const line of text.split("\n")) {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) {
        // Fenced code block: each non-blank line is a candidate shell command.
        const candidate = cleanDocCommand(line);
        if (candidate && DOC_KEYWORDS.test(candidate)) commands.add(candidate);
        continue;
      }
      // Prose: harvest inline `code spans` that mention a build/test/lint keyword.
      for (const match of line.matchAll(/`([^`]+)`/g)) {
        const candidate = cleanDocCommand(match[1]!);
        if (candidate && DOC_KEYWORDS.test(candidate)) commands.add(candidate);
      }
    }
    if (commands.size) excerpts.push({ path: name, commands: [...commands].slice(0, 8) });
    if (excerpts.length >= 6) break;
  }
  return excerpts;
}

async function readdirSafe(dir: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function collectCiCommands(repoPath: string): Promise<DetectedCommand[]> {
  const workflowsDir = path.join(repoPath, ".github", "workflows");
  if (!(await exists(workflowsDir))) return [];

  let files: string[];
  try {
    files = await walkDir(workflowsDir, {
      fileFilter: (entry) => /\.(ya?ml)$/.test(entry.name),
      relativePaths: true
    });
  } catch {
    return [];
  }

  const commands: DetectedCommand[] = [];
  const seen = new Set<string>();
  for (const rel of files.sort()) {
    const text = await readText(path.join(workflowsDir, rel));
    if (text === null) continue;
    for (const line of text.split("\n")) {
      // `run:` steps in GitHub Actions hold the shell commands. Match both
      // bare `run: cmd` and list-item `- run: cmd` forms.
      const runMatch = line.match(/^\s*-\s*run:\s*(.*)$|^\s*run:\s*(.*)$/);
      if (!runMatch) continue;
      const cleaned = cleanDocCommand((runMatch[1] ?? runMatch[2]) ?? "");
      if (!cleaned || !DOC_KEYWORDS.test(cleaned)) continue;
      const category = inferCategoryFromToken(cleaned);
      const key = `${rel}:${cleaned}`;
      if (seen.has(key)) continue;
      seen.add(key);
      commands.push({ command: cleaned, category, source: `CI ${rel} run step` });
    }
  }
  return commands.slice(0, 24);
}

function inferCategoryFromToken(command: string): GateCategory {
  const lower = command.toLowerCase();
  if (/\b(ruff|eslint|pylint|biome|flake8)\b/.test(lower)) return "lint";
  if (/\b(pytest|jest|vitest|mocha|test|check)\b/.test(lower)) return "test";
  if (/\b(mypy|tsc|typecheck|type-check)\b/.test(lower)) return "typecheck";
  if (/\b(build|compile|cargo build|go build)\b/.test(lower)) return "build";
  if (/\b(prettier|black|isort|format|fmt)\b/.test(lower)) return "format";
  if (/\b(bandit|safety|audit)\b/.test(lower)) return "security";
  return "other";
}

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
  const markers: ProjectMarker[] = [];
  const lockfiles = new Set<string>();

  for (const lock of LOCKFILES) {
    if (await exists(path.join(repoPath, lock.file))) {
      lockfiles.add(lock.file);
      markers.push(marker(lock.file, "lockfile", lock.stack));
    }
  }

  for (const entry of MARKER_FILES) {
    for (const file of entry.file) {
      if (await exists(path.join(repoPath, file))) {
        markers.push(marker(file, entry.purpose, entry.stack));
        break;
      }
    }
  }

  const commands: DetectedCommand[] = [];
  const node = await detectNodeCommands(repoPath, lockfiles);
  if (node) commands.push(...node.commands);
  const python = await detectPythonCommands(repoPath, lockfiles);
  if (python) commands.push(...python);
  const make = await detectMakefileCommands(repoPath);
  if (make) commands.push(...make);

  const docs = await collectDocCommands(repoPath);
  const ci = await collectCiCommands(repoPath);

  const base: Omit<ProjectIntel, "summary"> = {
    repoPath,
    markers,
    commands: dedupeCommands(commands),
    docs,
    ci
  };
  return { ...base, summary: buildSummary(base) };
}
