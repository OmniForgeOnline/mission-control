import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  buildReviewerPrompt,
  formatReviewFinding,
  formatReviewRemediation,
  gatherReviewContext,
  parseReviewerVerdict
} from "../src/core/review/code-review.ts";
import type { HarnessTask } from "../src/core/types.ts";

const exec = promisify(execFile);

function baseTask(overrides: Partial<HarnessTask> = {}): HarnessTask {
  return {
    id: "9b4de099-a5ff-40e0-9410-86cca1902b7e",
    title: "Fix worktree branch naming",
    description: "## Goal\nUse short task ids in harness branch names.",
    agent: "grok",
    source: "manual",
    links: [],
    targets: [],
    messages: [],
    reviewState: "none",
    turnCount: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

describe("code review", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(path.join(tmpdir(), "harness-review-repo-"));
    await exec("git", ["init"], { cwd: repoDir });
    await exec("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
    await exec("git", ["config", "user.name", "Test"], { cwd: repoDir });
    await exec("git", ["branch", "-M", "main"], { cwd: repoDir });
    await writeFile(path.join(repoDir, "README.md"), "base\n", "utf8");
    await exec("git", ["add", "README.md"], { cwd: repoDir });
    await exec("git", ["commit", "-m", "Initial"], { cwd: repoDir });
    await writeFile(path.join(repoDir, "src.ts"), "export const value = 1;\n", "utf8");
    await exec("git", ["checkout", "-b", "harness/9b4de099a5ff"], { cwd: repoDir });
    await exec("git", ["add", "src.ts"], { cwd: repoDir });
    await exec("git", ["commit", "-m", "Add src.ts"], { cwd: repoDir });
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it("gathers programmatic review context from the checked-out worktree", async () => {
    const task = baseTask({
      mergeRequest: { provider: "gitlab", url: "https://gitlab.com/group/repo/-/merge_requests/12", number: 12 }
    });
    const context = await gatherReviewContext({
      task,
      workspace: {
        cwd: repoDir,
        repoPath: repoDir,
        branch: "harness/9b4de099a5ff",
        isRepo: true,
        created: false
      },
      gitState: {
        commitCount: 1,
        hasUnpushedCommits: false,
        hasUncommittedChanges: false,
        status: "",
        diff: "diff --git a/src.ts b/src.ts",
        branch: "harness/9b4de099a5ff",
        pushed: true
      },
      authorReply: "**Pushed.** harness/abc · 1 commit(s) · fix branch naming."
    });

    expect(context.workspace.branch).toBe("harness/9b4de099a5ff");
    expect(context.commitSubjects).toContain("Add src.ts");
    expect(context.changedFiles).toContain("src.ts");
    expect(context.diffStat).toContain("src.ts");
    expect(context.prefetchedFiles).toContain("export const value = 1;");
    expect(context.mergeRequestNote).toContain("[#12]");
    expect(context.checksNote).toContain("Mechanical checks passed");
  });

  it("buildReviewerPrompt includes programmatic workspace and excerpt context", () => {
    const prompt = buildReviewerPrompt({
      task: baseTask(),
      authorAgent: "grok",
      context: {
        workspace: {
          cwd: "/tmp/worktree",
          isRepo: true,
          repoPath: "/repo",
          branch: "harness/abc",
          baseBranch: "main",
          headSha: "deadbeef"
        },
        commitSubjects: ["Add src.ts"],
        changedFiles: ["src.ts"],
        diffStat: " src.ts | 1 +\n",
        diff: "diff --git a/src.ts b/src.ts",
        diffTruncated: false,
        prefetchedFiles: "### src.ts\n```\nexport const value = 1;\n```",
        authorReply: "**Pushed.** harness/abc · 1 commit(s) · fix branch naming.",
        checksNote: "Mechanical checks passed before this review (workflow advanced past checks).",
        mergeRequestNote: ""
      }
    });

    expect(prompt).toContain("author branch checked out");
    expect(prompt).toContain("/tmp/worktree");
    expect(prompt).toContain("harness/abc");
    expect(prompt).toContain("gathered programmatically");
    expect(prompt).toContain("Changed-file excerpts");
    expect(prompt).toContain("export const value = 1;");
    expect(prompt).toContain("fix branch naming");
    expect(prompt).toContain("request_changes");
    expect(prompt).toContain("code-review");
    expect(prompt).toContain("inlined below");
    expect(prompt).not.toContain("Load the `code-review` skill with `read_skill`");
  });

  it("parses legacy string comments", () => {
    const verdict = parseReviewerVerdict(
      '```json\n{"decision":"request_changes","summary":"Fix branch naming.","comments":["src/core/worktrees/worktrees.ts:18 — use shortId(task.id)"]}\n```'
    );

    expect(verdict.decision).toBe("changes_requested");
    expect(verdict.summary).toBe("Fix branch naming.");
    expect(verdict.comments).toHaveLength(1);
    expect(verdict.comments[0]?.text).toContain("shortId");
  });

  it("parses structured findings with evidence", () => {
    const verdict = parseReviewerVerdict(`
\`\`\`json
{
  "decision": "request_changes",
  "summary": "Branch naming uses the full task UUID.",
  "comments": [
    {
      "file_path": "src/core/worktrees/worktrees.ts",
      "start_line": 18,
      "end_line": 18,
      "severity": "HIGH",
      "category": "BUG",
      "confidence": 0.95,
      "title": "Branch uses full task UUID",
      "rationale": "Harness branches must use the short id.",
      "evidence": "+  const branch = \`harness/\${task.id}\`;",
      "fix_hint": "Use shortId(task.id)"
    }
  ]
}
\`\`\`
`);

    expect(verdict.decision).toBe("changes_requested");
    expect(verdict.comments[0]?.file_path).toBe("src/core/worktrees/worktrees.ts");
    expect(verdict.comments[0]?.severity).toBe("HIGH");
    expect(verdict.comments[0]?.evidence).toContain("harness/${task.id}");
  });

  it("repairs multiline evidence strings in reviewer JSON", () => {
    const verdict = parseReviewerVerdict(`
\`\`\`json
{
  "decision": "request_changes",
  "summary": "Locale dictionaries are incomplete.",
  "comments": [
    {
      "file_path": "frontend/ui/src/locales/nl/translation.json",
      "start_line": 45,
      "end_line": 55,
      "severity": "MEDIUM",
      "category": "BUG",
      "confidence": 0.95,
      "title": "English copy remains",
      "rationale": "Dutch still shows English strings.",
      "evidence": "\\"sidenavExtras\\": {
  \\"refreshPlanHeadline\\": \\"Refresh your plan\\""
    }
  ]
}
\`\`\`
`);

    expect(verdict.decision).toBe("changes_requested");
    expect(verdict.comments[0]?.title).toBe("English copy remains");
  });

  it("routes comment-only reviewer verdicts back to the implementer", () => {
    const verdict = parseReviewerVerdict(`
\`\`\`json
{
  "decision": "comment",
  "summary": "Looks good overall; leaving low-severity observations only.",
  "comments": [
    {
      "file_path": "src/example.ts",
      "start_line": 10,
      "severity": "LOW",
      "title": "Consider adding tests"
    }
  ]
}
\`\`\`
`);

    expect(verdict.decision).toBe("changes_requested");
    expect(verdict.summary).toContain("Looks good overall");
  });

  it("routes approving decisions with malformed reviewer comments back to the implementer", async () => {
    const reply = `
\`\`\`json
{
  "decision": "approve",
  "summary": "Solid, correct frontend implementation: the auto-retry state machine is bounded and re-validated, pure helpers are well-tested, and the UI wiring is sound; only minor observations remain.",
  "comments": [
    {
      "file_path": ".githooks/pre-commit",
      "start_line": 67,
      "end_line": 185,
      "severity": "LOW",
      "category": "ARCHITECTURE",
      "confidence": 0.9,
      "title": "Unrelated release-notes enforcement removal is bundled into the feature PR",
      "rationale": "This is operator-initiated but orthogonal.",
      "evidence": "-RELEASE_NOTES_FILE=\\"RELEASE_NOTES.md\\"
...
-  printf '%s\\

| ' \\"$branch_changed_files\\" | grep -q \\"^\${RELEASE_NOTES_FILE}$\\" |
| --- | --- |
-}",
      "fix_hint": "Split into its own commit on a dedicated chore branch."
    }
  ]
}
\`\`\`
`;

    const verdict = parseReviewerVerdict(reply);

    expect(verdict.parseFailed).toBeUndefined();
    expect(verdict.decision).toBe("changes_requested");
    expect(verdict.summary).toContain("Solid, correct frontend implementation");
  });

  it("formats structured findings for author remediation", () => {
    const verdict = parseReviewerVerdict(`
\`\`\`json
{
  "decision": "request_changes",
  "summary": "Branch naming uses the full task UUID.",
  "comments": [
    {
      "file_path": "src/core/worktrees/worktrees.ts",
      "start_line": 18,
      "severity": "HIGH",
      "title": "Branch uses full task UUID",
      "rationale": "Harness branches must use the short id.",
      "evidence": "+  const branch = \`harness/\${task.id}\`;",
      "fix_hint": "Use shortId(task.id)"
    }
  ]
}
\`\`\`
`);

    const formatted = formatReviewFinding(verdict.comments[0]!);
    expect(formatted).toContain("[HIGH]");
    expect(formatted).toContain("src/core/worktrees/worktrees.ts:18");
    expect(formatted).toContain("Branch uses full task UUID");
    expect(formatted).toContain("evidence:");
    expect(formatted).toContain("Use shortId(task.id)");

    const remediation = formatReviewRemediation(verdict);
    expect(remediation).toContain("Reviewer requested changes:");
    expect(remediation).toContain("Findings:");
    expect(remediation).toContain("Fix the issues, commit, and push again.");
  });

  it("repairs multiline evidence strings from run 9a28306d", async () => {
    const fixture = await readFile(
      path.join(import.meta.dirname, "fixtures/reviewer-verdict-multiline-evidence.md"),
      "utf8"
    );
    const verdict = parseReviewerVerdict(fixture);

    expect(verdict.decision).toBe("changes_requested");
    expect(verdict.parseFailed).toBeUndefined();
    expect(verdict.comments).toHaveLength(2);
    expect(verdict.comments[0]?.title).toBe("Non-English locale still contains English UI copy");
    expect(verdict.comments[0]?.evidence).toContain("sidenavExtras");
    expect(verdict.comments[1]?.file_path).toBe("frontend/ui/src/pages/transcription/index.tsx");
    expect(verdict.comments[1]?.title).toBe("Reconnect sentinel is compared to localized text");
  });

  it("marks parse failures explicitly", () => {
    const verdict = parseReviewerVerdict('```json\n{not valid json\n```');
    expect(verdict.decision).toBe("none");
    expect(verdict.parseFailed).toBe(true);
  });

  it("marks valid non-object JSON as parse failures", () => {
    for (const candidate of ["null", '"approve"', "42", "true", "[]"]) {
      const verdict = parseReviewerVerdict(`\`\`\`json\n${candidate}\n\`\`\``);
      expect(verdict.decision).toBe("none");
      expect(verdict.parseFailed).toBe(true);
    }
  });
});
