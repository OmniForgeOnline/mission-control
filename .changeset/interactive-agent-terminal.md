---
"@omniforge/mission-control": minor
---

Interactive agent terminal for plan/authoring workflow steps, with dual-mode routing and denser ticket UI.

- **Interactive PTY turns:** human-facing `conversation` / `agent_turn` steps run the real agent TUI (Claude, Codex, etc.) in a `node-pty` session; the UI attaches via xterm.js + WebSocket. Operator **Done** / **Block** advances or blocks the step — quitting the CLI alone does not.
- **Same prompt as headless:** interactive launch passes model, effort, plan/execute mode, and the harness task prompt on argv (file fallback for large prompts), so the operator watches the same work the harness started — not an empty second session.
- **Headless stays for automation:** review, remediation, ACP, and classify remain non-interactive print/exec runs.
- **Ticket UI polish:** collapsible left rail with hover tips; workflow canvas/details vertical split defaults and collapse; denser step chrome (settings + Approve/Done/Block on one row); removed step-level project rebinding, Skip, minimap, and redundant terminal chrome.
