---
name: add-agent-cli
description: How to register a new agent CLI tool and model pool in the harness config.
---

# Add an Agent CLI

## When to use

You want the harness to route work to a new command-line agent (its own binary, or
an existing one pointed at a different provider/model). Configuration lives in
`data/state/agent-config.json` — there is no AI flow; you edit the config directly or
use the `/api/agent-config/*` endpoints, then toggle/remove entries in Settings → Tools & model pools.

## How

1. Confirm the CLI is installed and learn its flags: `command -v <bin>`, then `<bin> --help`.
2. Add a **tool** to `tools[]`. Use a built-in `adapter` (`codex` | `claude` | `grok`) only for
   CLIs that match those wire protocols; otherwise use `generic` and give a `commandTemplate`
   whose tokens are expanded at launch: `{prompt}`, `{model}`, `{cwd}`, `{effort}`, `{session}`.

       {
         "id": "kilo-cli",
         "displayName": "Kilo",
         "command": "kilo",
         "adapter": "generic",
         "enabled": true,
         "builtin": false,
         "supportsEffort": false,
         "effortLevels": [],
         "cli": {},
         "commandTemplate": ["run", "--prompt", "{prompt}"],
         "usage": { "kind": "usage-only" }
       }

3. Add at least one **model pool** to `pools[]` (a tool with no pool is unroutable). `modelArgs`
   select the model; `modelEnv` injects base URL / API-key var names. `capabilities` must include
   the workflow roles you want it for (`author`, `reviewer`).

       {
         "id": "kilo-local",
         "toolId": "kilo-cli",
         "displayName": "Kilo (local)",
         "modelArgs": ["--model", "local"],
         "modelEnv": {},
         "capabilities": ["author", "reviewer"],
         "qualityWeight": 60,
         "tier": "free",
         "usage": { "kind": "usage-only" },
         "usageSource": "none",
         "enabled": true,
         "builtin": false
       }

4. Pick the right `usage.kind`: `quota` (needs `period` + numeric `limit`), `usage-only`
   (tracked, no cap), or `unavailable` (capless provider — never add a fake `limit`).
5. The routing profiles in `profiles[]` resolve a role to a pool by `requiredCapability` and
   `minQuality`; a new pool is eligible as soon as its capabilities match.

## Anti-patterns

- Inventing a `limit` for a capless provider — use `{ "kind": "unavailable" }`.
- Editing or deleting `builtin: true` entries (codex/claude/grok) — add alongside them.
- Adding a tool with no model pool, or reusing an existing `id` (tool/pool ids must be unique).
- Hand-writing adapter wire formats — `generic` + `commandTemplate` covers most CLIs.

## Programmatic surface

- `data/state/agent-config.json` — the canonical config (`tools`, `pools`, `profiles`).
- `PUT /api/agent-config/tools` · `PUT /api/agent-config/pools` · `PUT /api/agent-config/profiles` — upsert.
- `DELETE /api/agent-config/tools/:id` · `DELETE /api/agent-config/pools/:id` — remove non-builtin entries.
- `src/runners/adapter.ts` — `generic` token expansion (`{prompt}`, `{model}`, `{cwd}`, `{effort}`, `{session}`).
