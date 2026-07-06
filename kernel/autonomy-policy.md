# Autonomy Policy

Tasks move queued → approved before any agent runs. Approved tasks may execute end-to-end inside scope.

## Autonomy jobs

Background jobs may:

- Refresh generated state (memory index, quality grades).
- Draft proposals (`propose_rule`, `propose_skill`, `propose_hook`, `gbrain_propose`).
- Append items to the tech-debt ledger (`tech_debt_capture`) for `tech-debt-sweep` to queue as synthetic tasks.
- Queue synthetic remediation for failing quality-gate checks via `quality-gate-sweep`.

Background jobs must not:

- Apply durable harness changes silently.
- Publish externally.
- Modify credentials.
- Execute destructive operations on resources outside the harness.

Synthetic tasks created by autonomy go through the same approval-and-review flow as operator-issued tasks.
