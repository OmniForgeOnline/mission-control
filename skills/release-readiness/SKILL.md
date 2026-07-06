---
name: release-readiness
description: Pre-release checklist for version bumps, changelogs, and deploy safety.
---

# Release Readiness

## When to use

Before shipping a versioned release, deploy, or customer-visible rollout. Use when the task needs a go/no-go assessment beyond unit tests.

## How

1. Confirm the change set: commits, migrations, config, feature flags.
2. Update or draft changelog entries for user-visible changes.
3. Verify version bump policy (semver) if applicable.
4. Run release-critical checks: build, test, smoke paths, rollback plan.
5. List deploy steps and who approves each gate.

Deliver a short readiness report:
- **Ready** — yes / no / conditional
- **Blockers** — must-fix before ship
- **Changelog** — draft bullets
- **Deploy** — ordered steps and rollback

## Anti-patterns

- Shipping without a rollback story.
- Changelog entries that only say "misc fixes".
- Skipping migration or config verification.
- Bundling unrelated changes into a release branch.

## Programmatic surface

- `gbrain_search("release process")` — team-specific deploy conventions.