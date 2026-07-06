import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";

import { onboardProject, type ProjectRecord } from "../src/core/projects/registry.ts";
import {
  isMutatingCommand,
  isVerificationCategory,
  parseAndValidateQualityGate,
  readProjectQualityGate,
  validateGateChecks,
  writeQualityGate
} from "../src/core/projects/quality-gate.ts";
import {
  generateProjectQualityGate,
  summarizeAgentFailure
} from "../src/core/projects/quality-gate-generation.ts";
import { collectDocCommands } from "../src/core/projects/intel-docs-ci.ts";
import { planProjectChecks } from "../src/core/projects/project-checks.ts";
import { DeterministicAgentRunner } from "./helpers/deterministic-runner.ts";
import type { AgentRunner, AgentTurnRequest, AgentTurnResult } from "../src/runners/types.ts";

function repliesRunner(reply: string): DeterministicAgentRunner {
  const runner = new DeterministicAgentRunner("claude");
  runner.setReplies([reply]);
  return runner;
}

/** A claude stream-json line emitted when the model API rejects with a retryable error. */
function apiRetryLine(attempt: number, status: number, error: string): string {
  return JSON.stringify({
    type: "system",
    subtype: "api_retry",
    attempt,
    max_retries: 10,
    retry_delay_ms: 500 * attempt,
    error_status: status,
    error,
    session_id: "test-session"
  });
}

/**
 * A runner that emits the given stream lines then hangs until aborted, mirroring a
 * claude turn stuck retrying an overloaded API. Used with a tiny timeoutMs to drive
 * the generation timeout path without waiting real seconds.
 */
class HangingRetryRunner implements AgentRunner {
  readonly agent = "claude";
  private release: (() => void) | undefined;
  constructor(private readonly lines: string[]) {}
  async runTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
    for (const line of this.lines) request.onOutput?.(`${line}\n`);
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
    return { reply: "", exitCode: 0, command: "hanging", rawLog: "" };
  }
  abort(): void {
    this.release?.();
  }
}

const READY_RUFF = JSON.stringify({
  status: "ready",
  checks: [
    {
      name: "lint",
      category: "lint",
      command: "ruff check .",
      required: true,
      evidence: ["pyproject.toml [tool.ruff]"]
    }
  ],
  rationale: "Ruff is declared in pyproject.toml."
});

describe("collectDocCommands harvest", () => {
  it("drops full-line shell comments so they can never become checks", async () => {
    // A fenced README block almost always opens with a `#` comment (`# Build the
    // project`). Such a line is not a command: it carries a build/test keyword, so
    // without stripping the `#` it would be harvested and, in the fallback synthesis,
    // persisted as a required check whose program is `#` (ENOENT every turn).
    const tmp = await mkdtemp(path.join(os.tmpdir(), "harness-qg-doc-"));
    try {
      await writeFile(
        path.join(tmp, "README.md"),
        ["```bash", "# Build the project", "npm run build", "```"].join("\n"),
        "utf8"
      );
      const docs = await collectDocCommands(tmp);
      const commands = docs.flatMap((d) => d.commands);
      expect(commands).toContain("npm run build");
      expect(commands).not.toContain("# Build the project");
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe("isMutatingCommand", () => {
  // Commands that acquire dependencies OR publish/deploy/serve/release mutate state
  // or hit the network instead of verifying behaviour, so the gate (verify, don't
  // mutate) must never persist them as a check. The predicate classifies the common
  // install/fetch forms and the release/deploy verbs; mvn/gradle `install` are
  // excluded because those run the test suite (a real verify command).
  it.each<[command: string, expected: boolean]>([
    ["npm ci", true],
    ["npm install", true],
    ["npm install --no-audit --no-fund", true],
    ["npm i", true],
    ["npm add left-pad", true],
    ["yarn install", true],
    ["pnpm install", true],
    ["bun install", true],
    ["bun add foo", true],
    ["pip install -r requirements.txt", true],
    ["uv sync", true],
    ["uv pip install pkg", true],
    ["poetry install", true],
    ["bundle install", true],
    ["gem install rspec", true],
    ["composer install", true],
    ["cargo fetch", true],
    ["cargo add serde", true],
    ["dotnet restore", true],
    ["go mod download", true],
    ["go get example.com/pkg", true],
    ["flutter pub get", true],
    ["make install", true],
    ["make deps", true],
    // release/deploy verbs: publish, ship, or run externally rather than verify
    ["npm publish", true],
    ["npm run publish", true],
    ["npm run deploy", true],
    ["npm run serve", true],
    ["npm run release", true],
    ["npm publish --access public", true],
    ["yarn publish", true],
    ["pnpm publish", true],
    ["bun publish", true],
    ["make publish", true],
    ["make deploy", true],
    ["make serve", true],
    ["make release", true],
    ["make ship", true],
    ["make distribute", true],
    ["make release stable", true],
    ["cargo publish", true],
    ["mvn deploy", true],
    ["gradle publish", true],
    // tool-agnostic deploy/publish tools outside the curated npm/make/cargo/mvn/gradle
    // list: cdk deploy, terraform apply, kubectl apply, helm upgrade, serverless/sam
    // deploy, pulumi up, vercel deploy, docker push, git push, terraform destroy
    // mutate published state or infrastructure, so they must be treated as mutating
    // even though the tool is not enumerated (the agent may emit them despite intent).
    ["cdk deploy", true],
    ["terraform apply", true],
    ["kubectl apply -f k8s.yaml", true],
    ["helm upgrade --install release ./chart", true],
    ["serverless deploy", true],
    ["sam deploy", true],
    ["pulumi up", true],
    ["vercel deploy", true],
    ["docker push ghcr.io/org/app", true],
    ["git push origin main", true],
    ["terraform destroy", true],
    // watch mode: a process that never exits on its own (jest/tsc/webpack/esbuild
    // --watch, or an npm/yarn/pnpm script named `*:watch`/`*-watch`/`watch`). It runs
    // indefinitely instead of verifying behaviour, so like `serve` it must never
    // become a blocking check the no-timeout executor would hang on.
    ["npm run -s test:watch", true],
    ["npm run -s build:watch", true],
    ["yarn test:watch", true],
    ["pnpm run build:watch", true],
    ["npm run -s test-watch", true],
    ["npm run -s watch", true],
    ["jest --watch", true],
    ["jest --watchAll", true],
    ["tsc --watch", true],
    ["webpack --watch", true],
    // verify commands and bare test/build/lint invocations are NOT mutating
    ["npm test", false],
    ["npm run build", false],
    ["npm run -s lint", false],
    ["npm run install", false],
    ["uv run pytest", false],
    ["cargo build", false],
    ["go test ./...", false],
    ["make test", false],
    ["dotnet test", false],
    ["ruff check .", false],
    ["pytest", false],
    // a release/deploy *token* that is part of a larger target is NOT a release verb:
    // `cargo build --release` is a build, `make release-notes` / `npm run deploy-tests`
    // are bespoke targets, not publish/deploy steps.
    ["cargo build --release", false],
    ["make release-notes", false],
    ["npm run deploy-tests", false],
    // a mutating *token* that is part of a larger hyphenated target is NOT a mutating
    // verb: `make apply-migrations` / `make push-images` are bespoke targets, so the
    // tool-agnostic clause's whitespace anchoring must not trip on the embedded verb.
    ["make apply-migrations", false],
    ["make push-images", false],
    // mvn/gradle install run the test suite -> intentionally NOT classified as mutating
    ["mvn install", false],
    ["gradle install", false],
    // --no-watch negates watch mode, and a bare -w is ambiguous (npm/yarn/pnpm use it
    // for the workspace flag), so neither is treated as watch mode.
    ["jest --no-watch", false],
    ["npm run build -w packages/web", false]
  ])("classifies %s as %s", (command, expected) => {
    expect(isMutatingCommand(command)).toBe(expected);
  });
});

describe("isVerificationCategory", () => {
  // Only known verification categories may block the gate; format and the catch-all
  // "other" are advisory (we don't block on a command whose effect we can't pin down).
  it.each<[category: string, expected: boolean]>([
    ["lint", true],
    ["test", true],
    ["typecheck", true],
    ["build", true],
    ["security", true],
    ["format", false],
    ["other", false]
  ])("classifies %s as %s", (category, expected) => {
    expect(isVerificationCategory(category as never)).toBe(expected);
  });
});

describe("parseAndValidateQualityGate", () => {
  it("accepts a valid ready object with evidence", () => {
    const result = parseAndValidateQualityGate(READY_RUFF);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.file.status).toBe("ready");
      expect(result.file.checks[0]!.evidence).toContain("pyproject.toml [tool.ruff]");
    }
  });

  it("accepts output wrapped in a ```json fence", () => {
    const result = parseAndValidateQualityGate("```json\n" + READY_RUFF + "\n```");
    expect(result.ok).toBe(true);
  });

  it("rejects a ready config with no evidence-backed checks (no generic fallback)", () => {
    const bad = JSON.stringify({
      status: "ready",
      checks: [{ name: "lint", category: "lint", command: "echo lint", required: true }]
      // no evidence -> dropped -> ready with zero checks -> rejected
    });
    const result = parseAndValidateQualityGate(bad);
    expect(result.ok).toBe(false);
  });

  it("accepts an incomplete config that names its gaps", () => {
    const result = parseAndValidateQualityGate(
      JSON.stringify({ status: "incomplete", checks: [], needsResolution: ["No test runner declared."] })
    );
    expect(result.ok).toBe(true);
  });

  it("rejects an incomplete config without needsResolution", () => {
    const result = parseAndValidateQualityGate(JSON.stringify({ status: "incomplete", checks: [] }));
    expect(result.ok).toBe(false);
  });

  it("rejects an invalid status", () => {
    const result = parseAndValidateQualityGate(JSON.stringify({ status: "maybe", checks: [] }));
    expect(result.ok).toBe(false);
  });

  it("rejects non-JSON output", () => {
    const result = parseAndValidateQualityGate("I think you should run pytest");
    expect(result.ok).toBe(false);
  });
});

/** A ready config carrying a single lint check with an optional workingDirectory. */
function readyCheckWith(workingDirectory?: string): string {
  const check: Record<string, unknown> = {
    name: "lint",
    category: "lint",
    command: "ruff check .",
    required: true,
    evidence: ["pyproject.toml [tool.ruff]"]
  };
  if (workingDirectory !== undefined) check["workingDirectory"] = workingDirectory;
  return JSON.stringify({ status: "ready", checks: [check], rationale: "Ruff in pyproject.toml." });
}

describe("parseAndValidateQualityGate workingDirectory containment", () => {
  it("keeps a safe relative working directory", () => {
    const result = parseAndValidateQualityGate(readyCheckWith("packages/web"));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.file.checks[0]!.workingDirectory).toBe("packages/web");
  });

  it("keeps an interior .. that folds back inside the repo", () => {
    // a/../b normalizes to b, which stays inside the repo root.
    const result = parseAndValidateQualityGate(readyCheckWith("a/../b"));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.file.checks[0]!.workingDirectory).toBe("a/../b");
  });

  it("drops an absolute working directory so the check runs from the repo root", () => {
    const result = parseAndValidateQualityGate(readyCheckWith("/etc"));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.file.checks[0]!.workingDirectory).toBeUndefined();
  });

  it("drops a working directory that escapes the repo via ..", () => {
    const result = parseAndValidateQualityGate(readyCheckWith("../sibling"));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.file.checks[0]!.workingDirectory).toBeUndefined();
  });

  it("drops a deeper traversal that normalizes outside the repo", () => {
    // a/../../escape normalizes to ../escape, which escapes the root.
    const result = parseAndValidateQualityGate(readyCheckWith("a/../../escape"));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.file.checks[0]!.workingDirectory).toBeUndefined();
  });
});

/** A ready config carrying one check with an arbitrary command and evidence. */
function readyWithCommand(command: string): string {
  return JSON.stringify({
    status: "ready",
    checks: [{ name: "x", category: "test", command, required: true, evidence: ["repo"] }],
    rationale: "x"
  });
}

describe("parseAndValidateQualityGate shell-syntax contract", () => {
  // The check executor spawns each command directly (shell: false), so a command
  // that relies on shell operators cannot run correctly: `a && b` runs only `a`
  // (with `&&`, `b` as junk argv), `cd x && c` fails to spawn the `cd` builtin,
  // and pipes/redirections/substitution are passed as literal argv. Such commands
  // must be rejected at the persistence boundary rather than stored to mis-run.
  it("rejects a command that chains stages with &&", () => {
    const result = parseAndValidateQualityGate(readyWithCommand("npm run lint && npm run test"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/&&/);
  });

  it("rejects a piped command", () => {
    expect(parseAndValidateQualityGate(readyWithCommand("pytest | tee out.txt")).ok).toBe(false);
  });

  it("rejects a cd-prefixed command", () => {
    expect(parseAndValidateQualityGate(readyWithCommand("cd packages/api && npm test")).ok).toBe(false);
  });

  it("rejects a bare leading cd with no shell operator to catch it", () => {
    // `cd` is a shell builtin: spawned directly it cannot change the executor's
    // directory, so a leading `cd subdir` must use workingDirectory instead. The
    // validator's own rejection message promises this, so a bare `cd` (no && or |
    // to trip the operator scan) must still be rejected on its own.
    const result = parseAndValidateQualityGate(readyWithCommand("cd packages/api"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/\bcd\b/);
  });

  it("rejects a redirection", () => {
    expect(parseAndValidateQualityGate(readyWithCommand("make test > build.log")).ok).toBe(false);
  });

  it("rejects a leading NAME=value env assignment", () => {
    expect(parseAndValidateQualityGate(readyWithCommand("NODE_ENV=test npm test")).ok).toBe(false);
  });

  it("accepts a NAME=value argument that is not a leading env assignment", () => {
    // `make test VAR=1` passes VAR=1 as a make argument; only a LEADING assignment
    // (before the program) is shell env syntax the executor cannot honour.
    expect(parseAndValidateQualityGate(readyWithCommand("make test VAR=1")).ok).toBe(true);
  });

  it("accepts a shell operator inside a quoted argument (a literal, not an operator)", () => {
    expect(parseAndValidateQualityGate(readyWithCommand('./check.sh --label "a && b"')).ok).toBe(true);
  });

  it("accepts a clean multi-argument command", () => {
    expect(parseAndValidateQualityGate(readyWithCommand("ruff check --select E,F src/")).ok).toBe(true);
  });
});

/** A ready config carrying one check with an arbitrary command/category/required. */
function readyCheck(command: string, category: string, required: boolean): string {
  return JSON.stringify({
    status: "ready",
    checks: [{ name: "x", category, command, required, evidence: ["repo"] }],
    rationale: "x"
  });
}

describe("parseAndValidateQualityGate verify-don't-mutate", () => {
  // The gate verifies; it must never persist a mutating/network command or an
  // unrecognized command as a blocking check, regardless of what the agent claims.
  // A non-verification or mutating command is coerced to advisory (required: false)
  // rather than rejected, so one over-eager check cannot discard a whole response.
  it("coerces a release command (category other) to advisory", () => {
    const result = parseAndValidateQualityGate(readyCheck("npm publish", "other", true));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.file.checks[0]!.required).toBe(false);
  });

  it("coerces a mutating command even when the agent mis-categorizes it as verification", () => {
    // The agent labels `npm publish` as "build" and required. Category alone would
    // let it block; the command-text guard must still demote it to advisory so it
    // never runs (and never mutates published state) every turn.
    const result = parseAndValidateQualityGate(readyCheck("npm publish", "build", true));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.file.checks[0]!.required).toBe(false);
  });

  it("coerces a deploy command mis-categorized as test to advisory", () => {
    const result = parseAndValidateQualityGate(readyCheck("make deploy", "test", true));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.file.checks[0]!.required).toBe(false);
  });

  it("coerces a watch-mode script (mis-categorized as test) to advisory", () => {
    // The agent emits `npm run -s test:watch` as a required test check. Category
    // alone would let it block, but watch mode hangs the no-timeout executor, so the
    // command-text guard must demote it to advisory so it never blocks and never runs.
    const result = parseAndValidateQualityGate(readyCheck("npm run -s test:watch", "test", true));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.file.checks[0]!.required).toBe(false);
  });

  it("coerces a non-enumerated deploy tool (mis-categorized as build) to advisory", () => {
    // The agent files `cdk deploy` under a verification category ("build") and marks
    // it required. `cdk` is not in the curated npm/make/cargo/mvn/gradle verb list,
    // so without the tool-agnostic mutating-verb guard this would be persisted
    // required:true and would mutate infrastructure on every turn. The guard must
    // still demote it to advisory so it never blocks and never runs.
    const result = parseAndValidateQualityGate(readyCheck("cdk deploy", "build", true));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.file.checks[0]!.required).toBe(false);
  });

  it("coerces a non-verification 'other' command to advisory", () => {
    const result = parseAndValidateQualityGate(readyCheck("./scripts/smoke.sh", "other", true));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.file.checks[0]!.required).toBe(false);
  });

  it("coerces a format command to advisory even when the agent marks it required", () => {
    const result = parseAndValidateQualityGate(readyCheck("prettier --check .", "format", true));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.file.checks[0]!.required).toBe(false);
  });

  it("keeps a genuine verification command required", () => {
    const result = parseAndValidateQualityGate(readyCheck("ruff check .", "lint", true));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.file.checks[0]!.required).toBe(true);
  });
});

describe("summarizeAgentFailure", () => {
  it("returns null when the stream shows no API retries", () => {
    expect(summarizeAgentFailure('{"type":"system","subtype":"init"}\n')).toBeNull();
    expect(summarizeAgentFailure("")).toBeNull();
  });

  it("summarizes API retries with the last error status and reason", () => {
    const log = [apiRetryLine(1, 529, "overloaded"), apiRetryLine(2, 529, "overloaded")]
      .map((l) => `${l}\n`)
      .join("");
    const summary = summarizeAgentFailure(log);
    expect(summary).toContain("overloaded");
    expect(summary).toContain("529");
    expect(summary).toContain("2 retries");
  });
});

describe("validateGateChecks (operator edits)", () => {
  it("accepts valid verification checks", () => {
    const result = validateGateChecks([
      { name: "lint", category: "lint", command: "ruff check .", required: true }
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.checks[0]?.command).toBe("ruff check .");
  });

  it("rejects a mutating command", () => {
    const result = validateGateChecks([
      { name: "install", category: "build", command: "npm install", required: true }
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("mutating");
  });

  it("rejects a shell chain the no-shell executor cannot run", () => {
    const result = validateGateChecks([
      { name: "chain", category: "test", command: "npm run lint && npm run test", required: true }
    ]);
    expect(result.ok).toBe(false);
  });

  it("rejects duplicate names", () => {
    const result = validateGateChecks([
      { name: "lint", category: "lint", command: "ruff check .", required: true },
      { name: "lint", category: "lint", command: "eslint .", required: true }
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("duplicate");
  });
});

describe("generateProjectQualityGate lifecycle", () => {
  let root: string;
  let repo: string;
  let project: ProjectRecord;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "harness-qg-root-"));
    repo = path.join(root, "repo");
    execSync(`git init -q ${repo}`);
    execSync("git config user.email t@t.com", { cwd: repo });
    execSync("git config user.name t", { cwd: repo });
    project = await onboardProject(root, { repoPath: repo, name: "Repo" });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it("returns a pending placeholder before generation runs", async () => {
    const file = await readProjectQualityGate(root, project.id);
    expect(file.status).toBe("pending");
    expect(file.checks).toEqual([]);
  });

  it("stores a ready config when the agent returns valid evidence-backed output", async () => {
    await writeFile(path.join(repo, "pyproject.toml"), "[tool.ruff]\n", "utf8");
    const runner = repliesRunner(READY_RUFF);
    const file = await generateProjectQualityGate(root, project, { runner });

    expect(file.status).toBe("ready");
    expect(file.checks[0]!.command).toBe("ruff check .");
    const stored = await readProjectQualityGate(root, project.id);
    expect(stored.status).toBe("ready");
    expect(stored.generatedAt).toBeTruthy();
    expect(stored.intel).toBeTruthy();
  });

  it("fails loud with a reason when the agent output is invalid", async () => {
    await writeFile(path.join(repo, "pyproject.toml"), "[tool.ruff]\n[tool.pytest.ini_options]\n", "utf8");
    const runner = repliesRunner("nope, can't help");
    const file = await generateProjectQualityGate(root, project, { runner });

    // No fallback synthesis: a failed gate the operator can re-trigger is honest,
    // even though the repo has evidence the gate could have used.
    expect(file.status).toBe("failed");
    expect(file.checks).toEqual([]);
    expect(file.error ?? "").toContain("did not return valid output");
  });

  it("surfaces the API-overload reason in the failed gate when the turn times out", async () => {
    await writeFile(path.join(repo, "pyproject.toml"), "[tool.ruff]\n", "utf8");
    // The runner emits 529-overloaded retries then hangs. With a 50ms budget the
    // generation times out and records a `failed` gate whose error names the real
    // cause (overloaded API) rather than an opaque "timed out".
    const runner = new HangingRetryRunner([
      apiRetryLine(1, 529, "overloaded"),
      apiRetryLine(2, 529, "overloaded")
    ]);
    const file = await generateProjectQualityGate(root, project, { runner, timeoutMs: 50 });

    expect(file.status).toBe("failed");
    expect(file.checks).toEqual([]);
    expect(file.error ?? "").toContain("overloaded");
  });

  it("stores incomplete when the agent reports insufficient evidence", async () => {
    const runner = repliesRunner(
      JSON.stringify({
        status: "incomplete",
        checks: [],
        needsResolution: ["No lint/test/build commands documented."],
        rationale: "insufficient evidence"
      })
    );
    const file = await generateProjectQualityGate(root, project, { runner });
    expect(file.status).toBe("incomplete");
    expect(file.checks).toEqual([]);
    expect(file.needsResolution?.length).toBeGreaterThan(0);
  });

  it("fails loud on a docs-only repo when the agent fails (docs no longer rescue it)", async () => {
    // No manifest/Makefile/CI: the only evidence is fenced commands in the README.
    // With no deterministic fallback, an agent failure is a failure — the docs are
    // not silently folded into a gate. The operator regenerates.
    await writeFile(
      path.join(repo, "README.md"),
      "# Project\n\n## Usage\n\n```sh\nnpm test\nnpm run build\n```\n",
      "utf8"
    );
    const runner = repliesRunner("nope, can't help");
    const file = await generateProjectQualityGate(root, project, { runner });

    expect(file.status).toBe("failed");
    expect(file.checks).toEqual([]);
  });

  it("returns the same stamped config it persists on success (matches a later GET)", async () => {
    // The wait-mode regenerate route serializes this return value straight to the
    // HTTP response, while a subsequent GET reads the persisted file. They must be
    // identical, so the returned object carries the same generatedAt/repoPath/intel
    // that were written — not the raw, unstamped agent output.
    await writeFile(path.join(repo, "pyproject.toml"), "[tool.ruff]\n", "utf8");
    const runner = repliesRunner(READY_RUFF);
    const file = await generateProjectQualityGate(root, project, { runner });

    const stored = await readProjectQualityGate(root, project.id);
    expect(file).toEqual(stored);
    expect(file.generatedAt).toBeTruthy();
    expect(file.repoPath).toBe(project.repoPath);
    expect(file.intel).toBeTruthy();
  });

  it("returns the same stamped config it persists on failure (carries the error)", async () => {
    // The failure path stamps the file before writing. The return value must reflect
    // that same stamped failed gate, not an in-memory-only object.
    await writeFile(path.join(repo, "pyproject.toml"), "[tool.ruff]\n[tool.pytest.ini_options]\n", "utf8");
    const runner = repliesRunner("nope, can't help");
    const file = await generateProjectQualityGate(root, project, { runner });

    const stored = await readProjectQualityGate(root, project.id);
    expect(file).toEqual(stored);
    expect(file.status).toBe("failed");
    expect(file.error).toBeTruthy();
    expect(file.intel).toBeTruthy();
    expect(file.generatedAt).toBeTruthy();
  });
});

describe("planProjectChecks workingDirectory containment", () => {
  let root: string;
  let repo: string;
  let project: ProjectRecord;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "harness-qg-cwd-"));
    repo = path.join(root, "repo");
    execSync(`git init -q ${repo}`);
    execSync("git config user.email t@t.com", { cwd: repo });
    execSync("git config user.name t", { cwd: repo });
    project = await onboardProject(root, { repoPath: repo, name: "Repo" });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it("does not set PlannedCheck.cwd for an unsafe working directory stored on disk", async () => {
    // Stored configs are re-read with only a loose shape check, so the
    // containment guard must hold at the planning boundary, not just at parse.
    await writeQualityGate(root, project.id, {
      status: "ready",
      checks: [
        {
          name: "lint",
          category: "lint",
          command: "ruff check .",
          required: true,
          evidence: ["pyproject.toml"],
          workingDirectory: "/etc"
        }
      ]
    });
    const plan = await planProjectChecks(root, project.id, repo);
    expect(plan.source).toBe("quality-gate");
    const check = plan.checks.find((c) => c.name === "lint");
    expect(check).toBeTruthy();
    expect(check!.cwd).toBeUndefined();
  });

  it("sets PlannedCheck.cwd for a safe relative working directory", async () => {
    await writeQualityGate(root, project.id, {
      status: "ready",
      checks: [
        {
          name: "lint",
          category: "lint",
          command: "ruff check .",
          required: true,
          evidence: ["pyproject.toml"],
          workingDirectory: "packages/web"
        }
      ]
    });
    const plan = await planProjectChecks(root, project.id, repo);
    const check = plan.checks.find((c) => c.name === "lint");
    expect(check!.cwd).toBe("packages/web");
  });
});

describe("planProjectChecks shell-syntax guard", () => {
  let root: string;
  let repo: string;
  let project: ProjectRecord;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "harness-qg-shell-"));
    repo = path.join(root, "repo");
    execSync(`git init -q ${repo}`);
    execSync("git config user.email t@t.com", { cwd: repo });
    execSync("git config user.name t", { cwd: repo });
    project = await onboardProject(root, { repoPath: repo, name: "Repo" });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it("surfaces a stored shell-style command as an explicit skip, never silently mis-runs it", async () => {
    // Stored configs are re-read with only a loose shape check, so the shell-syntax
    // contract is enforced at the plan boundary too: a command the direct-spawn
    // executor cannot run becomes an unavailable check with a reason, rather than
    // being spawned and running only its first stage.
    await writeQualityGate(root, project.id, {
      status: "ready",
      checks: [
        {
          name: "ci",
          category: "test",
          command: "npm run lint && npm run test",
          required: true,
          evidence: [".github/workflows/ci.yml"]
        }
      ]
    });
    const plan = await planProjectChecks(root, project.id, repo);
    expect(plan.source).toBe("quality-gate");
    const check = plan.checks.find((c) => c.name === "ci");
    expect(check?.available).toBe(false);
    expect(check?.skipReason).toMatch(/shell syntax/);
  });
});

describe("planProjectChecks verify-don't-mutate guard", () => {
  let root: string;
  let repo: string;
  let project: ProjectRecord;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "harness-qg-mutate-"));
    repo = path.join(root, "repo");
    execSync(`git init -q ${repo}`);
    execSync("git config user.email t@t.com", { cwd: repo });
    execSync("git config user.name t", { cwd: repo });
    project = await onboardProject(root, { repoPath: repo, name: "Repo" });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it("does not block on a stored mutating command, even mis-categorized as verification", async () => {
    // Stored configs are re-read with only a loose shape check, so a pre-fix config
    // (or a hand-edited one) may carry `npm publish` as required:true under any
    // category. The plan boundary must re-enforce verify-don't-mutate so it never
    // reaches the executor: nothing is planned, the gate does not block on it.
    await writeQualityGate(root, project.id, {
      status: "ready",
      checks: [
        { name: "publish", category: "build", command: "npm publish", required: true, evidence: ["CI"] },
        { name: "deploy", category: "test", command: "make deploy", required: true, evidence: ["CI"] }
      ]
    });
    const plan = await planProjectChecks(root, project.id, repo);
    expect(plan.source).toBe("quality-gate");
    expect(plan.checks).toEqual([]);
  });

  it("does not block on a stored watch-mode check, even required and categorized as test", async () => {
    // Stored configs are re-read with only a loose shape check, so a pre-fix config
    // may carry `npm run -s test:watch` as required:true under a verification
    // category. The plan boundary must re-enforce the watch guard so a watch script
    // never reaches the no-timeout executor (which would hang the gate).
    await writeQualityGate(root, project.id, {
      status: "ready",
      checks: [
        {
          name: "test-watch",
          category: "test",
          command: "npm run -s test:watch",
          required: true,
          evidence: ["package.json"]
        }
      ]
    });
    const plan = await planProjectChecks(root, project.id, repo);
    expect(plan.source).toBe("quality-gate");
    expect(plan.checks).toEqual([]);
  });

  it("does not block on a stored 'other' command marked required", async () => {
    // An unrecognized command marked required (e.g. left by the pre-fix synthesis,
    // which made every non-format category required) must not block: only known
    // verification categories may drive the gate.
    await writeQualityGate(root, project.id, {
      status: "ready",
      checks: [
        { name: "smoke", category: "other", command: "./scripts/smoke.sh", required: true, evidence: ["README.md"] }
      ]
    });
    const plan = await planProjectChecks(root, project.id, repo);
    expect(plan.source).toBe("quality-gate");
    expect(plan.checks).toEqual([]);
  });

  it("still blocks on a genuine verification check alongside mutating ones", async () => {
    // A real lint check survives the guard while the mutating sibling is dropped,
    // so the gate keeps verifying without running the publish/deploy step.
    await writeQualityGate(root, project.id, {
      status: "ready",
      checks: [
        { name: "publish", category: "build", command: "npm publish", required: true, evidence: ["CI"] },
        { name: "lint", category: "lint", command: "ruff check .", required: true, evidence: ["pyproject.toml"] }
      ]
    });
    const plan = await planProjectChecks(root, project.id, repo);
    expect(plan.source).toBe("quality-gate");
    const names = plan.checks.map((c) => c.name);
    expect(names).toContain("lint");
    expect(names).not.toContain("publish");
  });
});
