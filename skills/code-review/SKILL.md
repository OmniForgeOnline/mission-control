---
name: code-review
description: Review another agent's pushed branch and emit a structured verdict.
---

# Code Review

## When to use

The harness scheduled you (the reviewer) after the author agent pushed commits on a `harness/<id>` branch.

The harness prepares review context programmatically before your turn:

- Reuses the author's isolated worktree with their branch checked out (repo tasks)
- Attaches diff, diff stat, commit subjects, changed-file list, and excerpts of changed files
- Includes task description, author handoff, checks status, and open PR/MR link when present

You still run inside that workspace cwd for deeper reads, but you should not need to gather baseline context yourself.

## How

1. Start from the programmatic diff and changed-file excerpts in your prompt.
2. Comment only on **changed lines** unless you read extra cwd context to validate impact.
3. Cross-check against the task description and author handoff, but do not approve without inspecting the attached diff.
4. Report only high-signal issues with confidence ≥ 0.85 and verbatim diff evidence.
5. Reply with a fenced JSON block first, then a brief prose explanation.

```json
{
  "decision": "approve" | "request_changes" | "comment",
  "summary": "<one sentence overall assessment>",
  "comments": [
    {
      "file_path": "src/foo.ts",
      "start_line": 42,
      "end_line": 42,
      "severity": "CRITICAL|HIGH|MEDIUM|LOW",
      "category": "BUG|SECURITY|PERFORMANCE|ARCHITECTURE",
      "confidence": 0.95,
      "title": "short issue title",
      "rationale": "specific impact in plain language",
      "evidence": "verbatim snippet from the diff",
      "fix_hint": "optional concrete fix"
    }
  ]
}
```

### Decision rules

- `approve` — no actionable issues in changed lines (empty `comments`, or only LOW-severity notes you are not blocking on)
- `request_changes` — one or more CRITICAL/HIGH/MEDIUM findings with diff evidence the author must fix
- `comment` — observations only; no blocking issues

### Do not comment on

- Import/module verification, syntax errors, type errors (tools catch these)
- Style, formatting, naming (linters/formatters handle these)
- Generic suggestions without concrete evidence
- Logging/debug statements unless sensitive data is logged
- Theoretical edge cases assuming broken invariants without diff evidence

### Distinguish bugs from improvements

**Flag as bugs:** removals that break functionality, data loss, regressions, control-flow errors (unreachable code, double HTTP responses, missing return after response).

**Do not flag:** new error handling, defensive checks, logging, or fallback logic.

### Severity

- **CRITICAL** — SQL injection, auth bypass, data loss, system crash, feature breakage
- **HIGH** — race conditions, memory leaks, breaking API changes, significant regressions
- **MEDIUM** — logic errors, missing validation, measurable performance issues
- **LOW** — minor edge cases with evident improvement (use sparingly)

### Evidence rules

- Each finding must quote verbatim evidence from the diff.
- Comment only on lines present in the diff.
- If you cannot point to exact diff evidence, skip the finding.
- **JSON validity:** use `\n` for line breaks inside JSON string values (never raw newlines inside quoted strings). Multi-line excerpts must be escaped on one logical line per field. The harness parses your fenced JSON programmatically; invalid JSON is treated as an unclear verdict and blocks the task.

## Examples

Approve (no issues):

```json
{"decision": "approve", "summary": "Worktree creation logic is correct and covered by tests.", "comments": []}
```

Request changes (structured finding):

```json
{
  "decision": "request_changes",
  "summary": "Branch naming uses the full task UUID instead of the short id.",
  "comments": [
    {
      "file_path": "src/core/worktrees.ts",
      "start_line": 18,
      "end_line": 18,
      "severity": "HIGH",
      "category": "BUG",
      "confidence": 0.95,
      "title": "Branch uses full task UUID",
      "rationale": "Harness branches must use the short id so operators can match branches to tasks.",
      "evidence": "+  const branch = `harness/${task.id}`;",
      "fix_hint": "Use shortId(task.id) instead of task.id"
    }
  ]
}
```

Multi-line evidence (escape newlines):

```json
{
  "evidence": "\"sidenavExtras\": {\n  \"refreshPlanHeadline\": \"Refresh your plan\","
}
```

## Anti-patterns

- Using `gh`, `glab`, or forge APIs (`gh pr view`, `gh pr diff`, `gh api`). The harness gives you the diff and worktree context; reply with the JSON verdict only.
- Modifying, committing, or pushing in the workspace. Reviewers are read-only.
- Re-gathering baseline context the harness already attached (diff stat, changed files, excerpts) unless you need deeper surrounding reads.
- Approving with no diff inspection.
- Rewriting the JSON schema. Keep `decision`, `summary`, and structured `comments`.
- Long prose without the JSON block — the harness parses the JSON to drive the next loop.
- Linter-level feedback, vague warnings, or findings without verbatim diff evidence.
- Raw newlines inside JSON string values — always escape as `\n`.

## Programmatic surface

- `read_run(runId, "log.txt")` — inspect what the author actually did.
- `gbrain_search(query)` — look up prior decisions if a pattern looks unfamiliar.
- `list_tasks(status="awaiting_review")` — see other reviews in flight.