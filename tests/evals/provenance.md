# Evaluation corpus provenance

Version **v1** of the evaluation corpus lives under `tests/evals/cases/v1/`. Cases are committed fixtures — they do not read ambient `HARNESS_ROOT` or call external services unless `integrationOnly: true` (none in v1).

## Sources

| Workflow | Coverage | Provenance |
| --- | --- | --- |
| `code-feature` | synthetic tiers plus historical medium and long-loop summaries | Historical summaries use hashed runtime-task references and retain no transcript, credentials, repository path, connector data, or unstable URL. |
| `bugfix` | small, medium, failure | Pattern-synthesized investigation/fix shapes from connector and API defects |
| `frontend-ui-change` | small, medium, failure | Pattern-synthesized catalog/responsive CSS and overflow regressions |
| `product-spec` | small, medium, failure | Pattern-synthesized spec drafts with/without concrete acceptance criteria |
| `blog-post`, `data-analysis` | shared release-brief acceptance cases | The same artifact is replayed through content and data review profiles alongside the code profile. |
| All other bundled workflows | synthetic (1 each) | Generated placeholders until historical evidence exists |

Historical extraction was performed from completed local runtime tasks available during Phase 0 review. The stored cases are privacy-reviewed summaries; coverage reports use `provenance.kind`, while `taskClass` describes the case shape.

## Redaction policy

Applied before cases are committed (see `src/core/inventory/redact.ts` and manual review):

- Secrets and tokens (`Bearer`, `sk-`, `ghp_`, `glpat-`, flag pairs like `--api-key`, `-H Authorization`) → `[REDACTED]`
- Operator names, customer emails, workspace ids
- Live task ids, forge URLs, and production hostnames
- Full agent transcripts — replaced with compact inputs + outcome contracts

The `long-review-loop` case remains synthetic. `historical-runtime-review-loop` is the genuinely historical long-loop summary and is tied to a hashed source record.

## Replay fixtures

Offline replay executes deterministic checks when `replay.fixtures` supplies:

- `workspacePath` for `checks-outcome`
- `reviewerReply` (inline or path) for `reviewer-verdict`
- `artifactPaths` for `artifact-present`

Cases missing required replay fixtures report unsupported checks and do not pass fresh replay.

## Schema

Cases validate through `src/core/evals/schema.ts` with `schemaVersion: 1`. Each case defines an **outcome** (artifact, deterministic checks, rubric) rather than expected agent prose.

## Verification

```bash
npm test -- tests/evals.test.ts tests/baseline.test.ts
```

Runs offline against committed fixtures only.
