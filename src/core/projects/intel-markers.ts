import path from "node:path";

import { pathExists, readTextFile } from "../infra/fs.ts";
import type { DetectedCommand, GateCategory, ProjectMarker, ProjectStack } from "./intel.ts";

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
  const raw = await readTextFile(path.join(repoPath, "package.json"));
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
  const pyproject = await readTextFile(path.join(repoPath, "pyproject.toml"));
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

async function detectMakefilePath(repoPath: string): Promise<string | null> {
  for (const name of ["Makefile", "makefile", "GNUmakefile"]) {
    const candidate = path.join(repoPath, name);
    if (await pathExists(candidate)) return candidate;
  }
  return null;
}

async function detectMakefileCommands(repoPath: string): Promise<DetectedCommand[] | null> {
  const makePath = await detectMakefilePath(repoPath);
  if (!makePath) return null;
  const text = await readTextFile(makePath);
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

/**
 * Detect recognized repo markers (manifests, lockfiles, build-automation files) at
 * the repo root. Returns the markers plus the lockfile set, which selects the
 * package/Python runner for manifest command detection.
 */
export async function detectMarkers(
  repoPath: string
): Promise<{ markers: ProjectMarker[]; lockfiles: Set<string> }> {
  const markers: ProjectMarker[] = [];
  const lockfiles = new Set<string>();

  for (const lock of LOCKFILES) {
    if (await pathExists(path.join(repoPath, lock.file))) {
      lockfiles.add(lock.file);
      markers.push(marker(lock.file, "lockfile", lock.stack));
    }
  }

  for (const entry of MARKER_FILES) {
    for (const file of entry.file) {
      if (await pathExists(path.join(repoPath, file))) {
        markers.push(marker(file, entry.purpose, entry.stack));
        break;
      }
    }
  }

  return { markers, lockfiles };
}

/**
 * Detect evidence-backed commands from the repo's declared automation: package
 * scripts, Python `[tool.*]` sections, and canonical Makefile targets. Each
 * command cites where it came from. `lockfiles` selects the package/Python runner.
 */
export async function detectManifestCommands(
  repoPath: string,
  lockfiles: Set<string>
): Promise<DetectedCommand[]> {
  const commands: DetectedCommand[] = [];
  const node = await detectNodeCommands(repoPath, lockfiles);
  if (node) commands.push(...node.commands);
  const python = await detectPythonCommands(repoPath, lockfiles);
  if (python) commands.push(...python);
  const make = await detectMakefileCommands(repoPath);
  if (make) commands.push(...make);
  return commands;
}
