---
name: harness-checks
description: How mechanical checks gate your push, and how to recover when they fail.
---

# Harness Checks

## When to use

Repo-scoped tasks where the workspace may contain `.harness/checks.yml`.

**Hybrid model:** the harness runs whatever commands the *project* defines. There is no global test suite. If the file is missing, checks are skipped automatically. When checks fail, the harness re-prompts the author with captured output — you fix; the harness does not patch code for you.

## How

1. Inspect `.harness/checks.yml` early when it exists. Typical shape:

       checks:
         - name: lint
           command: npm run lint
         - name: typecheck
           command: npm run -s build:typecheck
         - name: test
           command: npm test
       maxRounds: 3

2. Run the same commands locally before pushing. Failing fast is cheaper than a remediation round.
3. If the harness re-prompts you with `### Checks remediation round N` in the prompt body, treat it as the highest-priority instruction. Fix only what the failure shows; do not expand scope.
4. Push the fix on the same branch.

## Anti-patterns

- Skipping the checks because "it's a small change". The harness will rerun you regardless.
- Suppressing failures (disabling tests, adding `--no-verify`, modifying `.harness/checks.yml` to remove checks). File a `propose_rule` instead.
- Adding new checks during a remediation round. Ship the fix first, propose the new check separately.

## Programmatic surface

- The check config is just a file. `cat .harness/checks.yml` from `cwd` is the canonical read.
- `read_run(runId, "log.txt")` — see the exact output the previous turn captured.
