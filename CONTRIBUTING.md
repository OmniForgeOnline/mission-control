# Contributing to OmniForge Mission Control

Thanks for your interest in contributing. Mission Control is a local-first control panel for running AI coding agents against your own repositories.

## Set up

See the [README](./README.md) for prerequisites (Node 20+, npm 10+, git) and the [Quick start](./README.md#quick-start). In short:

```sh
npm install
npm start
```

Open `http://127.0.0.1:4827`. Install at least one supported agent CLI (`claude`, `codex`, `grok`, `opencode`, or an ACP-compatible tool) before running real workflow tasks.

## Before you submit

Run the full CI gate locally. CI runs this on Ubuntu and macOS across Node 20, 22, and 24 (see `.github/workflows/ci.yml`):

```sh
npm run check   # lint, typecheck, tests, knip, build
```

The pre-commit hook only applies a fast lint fix to staged files. The full gate runs in CI, so always run `npm run check` before pushing.

## Submitting a change

1. For anything beyond a small fix, open an issue first to discuss it.
2. Branch from `main` and keep commits focused (one logical change per PR).
3. For user-facing changes, add a changeset (`npm run changeset`) describing the change; it feeds the changelog and version bump.
4. Make sure `npm run check` passes.
5. Open a PR against `main` using the pull request template.

Runtime state lives under `HARNESS_ROOT`, never inside your source checkout, so local runs do not dirty the working tree.

## Policy changes

Behavioral rules live in [`kernel/`](./kernel) (operating principles, autonomy policy, memory policy). Treat changes there as policy decisions: open an issue to discuss before sending a PR.

## License

This project is licensed under the MIT License (see [LICENSE](./LICENSE) and [NOTICE](./NOTICE)). By contributing, you agree that your contributions are licensed under the MIT License, and that you have the right to make them (Developer Certificate of Origin, <https://developercertificate.org>). Please sign your commits with `git commit -s` to record this.
