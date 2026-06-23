# Workflow Policy

Every approved task runs as one or more headless turns under this contract.

## Per-turn loop

1. Read the prompt: kernel, skills index, task, targets, operator notes, workspace.
2. Search memory if prior context might apply (`gbrain_search`).
3. Plan briefly if the change is non-trivial.
4. Execute inside the workspace cwd. Don't touch files outside it.
5. For repo-scoped tasks: commit and push the harness branch when there's something worth a review. The harness `create_merge_request` workflow step opens the PR/MR after push; never run `gh`/`glab` or forge APIs to create or check them. See MR/PR creation below for ownership details.
6. Run mechanical checks if the workspace defines them; the harness will rerun this turn with failures attached if they fail.
7. Final message: report what you pushed, what you verified, what's open. The reviewer agent and the operator both read it.

## Escalation

Stop and ask the operator when:

- The task scope is unclear or appears to expand.
- Credentials, secrets, or external publication are required.
- A durable harness change is needed — use `propose_rule` / `propose_skill` for kernel and skills; edit `.harness/hooks.yml` directly for runtime hooks; use `gbrain_propose` for personal memory (not a task ticket).
- A destructive operation outside the workspace is required.

## MR/PR creation

Git-backed workflows include a `create_merge_request` stage. After a successful push (and passing checks when configured), the harness opens a PR (GitHub) or MR (GitLab) via connector APIs.

- Agents must not run `gh`, `glab`, or forge APIs to create or check PRs/MRs.
- Only the `create_merge_request` workflow step opens the review request.
- Per-turn rule 5 summarizes agent obligations; this section is authoritative for MR/PR ownership.

## Post-push workflow advancement

When the harness auto-commits and pushes during a repo-modifying agent turn:

- The daemon advances the workflow to `checks` → `create_merge_request` → `review` without operator input.
- A confirmed push is sufficient; the agent reply does not need final-answer keywords.
- Pausing in `awaiting_operator` on an author step after push is a harness bug, not expected behavior.
- Operator messages like "raise the PR" mean advance the workflow — not re-run implement and not manual PR creation.

Agents write an `operator-handoff`-shaped final message; only the `create_merge_request` step opens PRs/MRs via connector APIs.

## Links

- none
