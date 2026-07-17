# OmniForge Mission Control

Mission Control is a local-first control panel for running AI coding agents against your own repositories. It turns a request into a scoped ticket, routes that ticket through a workflow, keeps local project memory, and can hand completed work to PR or MR creation when you connect a Git provider.

For plan and authoring steps, you do not just watch a log: Mission Control opens the **real agent TUI** (Claude, Codex, and friends) inside the ticket. You see the same session the harness started, type into it when you need to, and mark the step **Done** when the work is finished. Automation steps (review, remediation, and similar) stay headless so the daemon can keep driving without a human at the keyboard.

It is designed for agentic workflows you can inspect: source code stays on your machine, runtime state lives outside the checkout, and connectors are optional.

![Mission Control home view](https://raw.githubusercontent.com/OmniForgeOnline/mission-control/main/docs/screenshot.png)

## What You Can Do

- Add local git repositories as projects and keep tasks scoped to a real repo.
- Run workflows for bug fixes, features, docs, incident response, frontend changes, research, and more.
- Use Claude, Codex, Grok, OpenCode, or ACP-compatible agents such as Kiro.
- **Sit inside the live agent session** on plan and authoring steps: full interactive TUI in the ticket, with Done / Block to advance or stop the workflow.
- Watch workflow graph progress, handoff notes, checks, and review status for automated steps.
- Keep durable local memory for each project.
- Connect GitHub or GitLab when you want Mission Control to open PRs or MRs.

## Interactive Agent Terminal

Human-facing steps and machine-facing steps use different runners on purpose.

| Step kind | Mode | What you get |
| --- | --- | --- |
| Plan / conversation, implementation `agent_turn` | **Interactive** | Real PTY + agent TUI in the ticket (xterm in the UI). Harness prompt, model, effort, and plan/execute mode match what headless would use. Operator **Done** advances the step; **Block** stops it. Quitting the CLI alone does not finish the workflow. |
| Review, checks remediation, ACP-only tools, classify | **Headless** | Non-interactive print/exec run. Output streams into the run log. The daemon advances when the process exits successfully. |

Why both exist:

- **Planning and implementation** benefit from the real TUI: you can answer questions, steer mid-turn, and see the agent work the same way you would in a terminal.
- **Review and automation** should not wait on a human sitting in a TUI. Headless keeps the pipeline moving.

The interactive session is started by the harness (one session per turn). The UI attaches to that session; it does not spawn a second empty agent.

Disable interactive mode for all steps with `HARNESS_INTERACTIVE=0` if you need fully headless runs (for example in constrained environments).

## Quick Start

Install globally from npm, then open the local app:

```sh
npm install -g @omniforge/mission-control
mission-control
```

Open `http://127.0.0.1:4827`.

Prefer not to install globally? Run it on demand:

```sh
npx @omniforge/mission-control
```

## First Run

The app opens with an inline setup checklist instead of a blocking wizard. A good first pass is:

1. Install at least one supported agent CLI and confirm it is on your `PATH`.
2. Add a project with the `+` next to **Projects** in the sidebar.
3. Open **Settings -> Agents** and choose the default agent you want workflow steps to use.
4. Optional: open **Connectors** and add GitHub or GitLab only if you want PR or MR workflows.
5. Open a project and run one of its quickstarts (for example a planning or feature workflow).
6. On the plan step, open the **Step** panel: the agent TUI appears in-ticket. Work with the agent there, then press **Done** when the step is finished.

Tasks require at least one supported agent CLI available in the shell that launches Mission Control.

## Prerequisites

- Node.js `>=20` and npm `>=10`.
- git on your `PATH`.
- One or more agent CLIs such as `claude`, `codex`, `grok`, `opencode`, or an ACP-compatible tool.
- Optional for GitHub: `gh auth login` or a token with `repo` scope.
- Optional for GitLab: a token with `api` scope.

The published package runs compiled JavaScript. Building from source additionally follows the repo's `.nvmrc` and Vite requirements.

## From Source

```sh
npm install
npm start
```

Open `http://127.0.0.1:4827`. Press `Ctrl+C` to stop.

On macOS and Linux, `./mc` is a shorthand for `npm start`.

## Commands

| Command | Description |
| --- | --- |
| `npm start` | Build the UI and start with real agents. |
| `npm run build` | Build the browser UI. |
| `npm test` | Run the Vitest suite. |
| `npm run check` | Full local quality gate: lint, typecheck, tests, knip, UI build, server build. |

### Stopping Mission Control

Stop the running server gracefully (it terminates all in-flight agent processes, stops the daemon, and closes the UI):

```sh
mission-control stop
```

You can also stop from the UI: open **System → Maintenance → Power → Shut down Mission Control** and confirm the warning. From the terminal where it runs, `Ctrl+C` works too. After a shutdown the UI stays offline until you start the app again with `mission-control`.

## Runtime State

Runtime state is not stored in the source checkout by default. Mission Control uses a platform-standard state directory:

- macOS: `~/Library/Application Support/mission-control`
- Linux: `$XDG_DATA_HOME/mission-control` or `~/.local/share/mission-control`
- Windows: `%APPDATA%\mission-control`

The runtime state directory contains settings, tasks, runs, generated indexes, seeded policies, project memory, and connector state.

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `4827` | HTTP port. |
| `HARNESS_HOST` | `127.0.0.1` | Network interface. Use `0.0.0.0` only when you intentionally want network access. |
| `HARNESS_ROOT` | Platform default | Runtime state directory. |
| `HARNESS_AUTONOMY` | `1` | Enables scheduled autonomy jobs. Set `0` to disable. |
| `HARNESS_INTERACTIVE` | `1` | Interactive PTY/TUI for plan and authoring steps. Set `0` to force headless for those steps too. |
| `HARNESS_EXECUTION_ENV` | `native` | `native` runs against host paths; `container` expects task targets under `HARNESS_PROJECTS_ROOT`. |
| `HARNESS_PROJECTS_ROOT` | Settings value | Root used for target suggestions and container-accessible project paths. |
| `HARNESS_VAULT` | Platform default | Connector token store: `keychain`, `file`, or `memory`. |

## Architecture

```text
src/
├── agents/       # Agent configuration, capabilities, optimization, runtime helpers
├── autonomy/     # Scheduled autonomy jobs and proposal generation
├── connectors/   # GitHub/GitLab connector state and operations
├── core/         # Projects, tasks, settings, workflows, checks, shared types
├── daemon/       # Task turn processing and workflow advancement
├── mcp/          # MCP tools exposed to agents
├── memory/       # Local gbrain memory search, indexing, and capture
├── runners/      # Interactive (PTY), headless, and ACP runner implementations
├── server/       # HTTP routes, WebSocket terminal attach, app server
├── terminal/     # PTY session manager, interactive launch, WS protocol
└── ui/           # Preact browser UI (including xterm step pane)

workflows/        # YAML workflow definitions
kernel/           # Seeded policy documents
tests/            # Unit and integration tests
```

The main loop is:

1. A project-scoped ticket is created from intake or a quickstart.
2. The daemon resolves the workflow step and agent (and interactive vs headless mode).
3. For plan/authoring steps, the interactive runner opens a real agent TUI in a PTY; the UI attaches over WebSocket. For review and automation, the headless runner runs print/exec and streams logs.
4. Operator **Done** / **Block** (interactive) or process exit (headless) completes the turn into durable run state.
5. Checks, review, handoff, and PR/MR creation advance through workflow steps.

## Connectors

Git providers are optional. Without connectors, Mission Control can still run local tasks, checks, memory, and reviews. Add connectors only when you want workflow steps to open PRs or MRs.

- GitHub: use `gh auth login` or add a token in **Connectors**.
- GitLab: add a token in **Connectors**.

Workflow PR/MR creation is handled by the `create_merge_request` step, not by ad-hoc shell commands.

## Local-First Notes

- Source repositories are selected explicitly as projects.
- Project memory is local and gitignored.
- Agent CLIs may contact their own providers according to how those tools are configured.
- Git provider tokens are stored through the configured vault backend.
- Set `HARNESS_HOST=127.0.0.1` unless you intentionally want the app reachable from another machine.

## Contributing

Run the full gate before opening a change:

```sh
npm run check
```

For targeted work, prefer the closest test first, then run the full gate before handoff. Tests that create harness state should use temporary roots and `ensureHarnessRepository(root)` rather than ambient runtime state.

## Policy Documents

Seeded operating policies live in:

- [`kernel/operating-principles.md`](./kernel/operating-principles.md)
- [`kernel/autonomy-policy.md`](./kernel/autonomy-policy.md)
- [`kernel/memory-policy.md`](./kernel/memory-policy.md)

These documents are copied into runtime state and used by the harness and agents.

## Support

- Bugs and feature requests: [GitHub Issues](https://github.com/OmniForgeOnline/mission-control/issues).
- Contact: <contact@omniforge.online>.

## License

This project is open source under the MIT License. See [`LICENSE`](./LICENSE) for the full terms.
