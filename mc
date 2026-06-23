#!/usr/bin/env bash
# Single entrypoint for the harness. Run from the repo root.
#   ./mc            Start the server (real agents, autonomy on). Ctrl+C to stop.
#   ./mc --fake     Start with the fake runner (no real agent calls).
#   ./mc --build    Build the browser UI (after changing client/ files).
#   ./mc --test     Run the test suite.
#   ./mc --check    Lint, typecheck, test, knip, and build (full CI gate).
#
# Env: PORT, HARNESS_RUNNER_MODE, HARNESS_AUTONOMY (default 1), HARNESS_ROOT

set -euo pipefail
cd "$(dirname "$0")"

# Fail fast with a clear message on an incompatible Node version, before the
# experimental-flag crash. (Windows users: use "npm start" instead of this script.)
node scripts/check-node.mjs

NODE_FLAGS=(--experimental-strip-types --experimental-transform-types --disable-warning=ExperimentalWarning)

# Autonomy is on by default. Override with HARNESS_AUTONOMY=0 ./mc.
export HARNESS_AUTONOMY="${HARNESS_AUTONOMY:-1}"

case "${1:-}" in
  --build)
    exec npx vite build -c vite.config.client.ts
    ;;
  --test)
    exec npx vitest run
    ;;
  --check)
    exec npm run check
    ;;
  --fake)
    # Build the browser UI on first run so `--fake` on a fresh clone is not an
    # API-only shell. Skip once dist/ui exists so repeated fake runs stay fast.
    [ -f dist/ui/index.html ] || npx vite build -c vite.config.client.ts
    # `exec` replaces this shell with node, so node becomes the foreground
    # process directly. Ctrl+C (SIGINT) goes straight to it — no wrapper, no
    # signal forwarding needed.
    HARNESS_RUNNER_MODE=fake exec node "${NODE_FLAGS[@]}" src/server/index.ts
    ;;
  ""|--real)
    npx vite build -c vite.config.client.ts
    HARNESS_RUNNER_MODE="${HARNESS_RUNNER_MODE:-real}" exec node "${NODE_FLAGS[@]}" src/server/index.ts
    ;;
  *)
    echo "Usage: ./mc [--fake|--build|--test|--check]"
    exit 1
    ;;
esac
