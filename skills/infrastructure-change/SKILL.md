---
name: infrastructure-change
description: Risk assessment and safe execution for infra, deploy, and platform changes.
---

# Infrastructure Change

## When to use

Infrastructure-change workflow risk_assessment steps and any task touching deploy config, cloud resources, DNS, CI/CD, or observability.

## How

1. Document current state: what runs where, who depends on it, blast radius.
2. Classify change type: config-only, scaling, networking, data store, secrets.
3. Require rollback plan before any mutating step — how to revert in <15 minutes.
4. Identify verification: health checks, metrics, smoke tests, canary criteria.
5. List approval gates: production access, billing impact, customer downtime.

For conversation steps, emit `<proposed_plan>` with: Change, Risk, Rollback, Verification, Approvals.

## Anti-patterns

- Applying production changes without rollback documented.
- Modifying secrets or IAM broadly when a narrow change suffices.
- Skipping staging or dry-run when available.
- Infra changes bundled with unrelated application refactors.

## Programmatic surface

- `gbrain_search("infra runbook")` — team deploy conventions.
- `pr-driven-execution` skill — version infra changes through git when applicable.
- `tech_debt_capture(...)` — deferred hardening items.