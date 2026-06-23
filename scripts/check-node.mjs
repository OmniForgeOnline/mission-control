#!/usr/bin/env node
// Preflight: Mission Control needs Node 20 or newer. Fail fast with a clear
// message instead of a confusing failure later. Plain ESM, so it runs on any
// Node version and can detect the mismatch itself.

const REQUIRED_MAJOR = 20;

const major = Number(process.versions.node.split(".")[0] ?? 0);
if (major < REQUIRED_MAJOR) {
  console.error(
    `Mission Control needs Node ${REQUIRED_MAJOR} or newer (you have ${process.versions.node}).`
  );
  console.error("Install Node 20+ from https://nodejs.org, or run: nvm install 20");
  process.exit(1);
}
