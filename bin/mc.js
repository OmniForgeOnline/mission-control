#!/usr/bin/env node
// Global launcher for @omniforge/mission-control.
// Runs the compiled server (dist/server.js) under plain Node. Sets
// HARNESS_PACKAGE_ROOT so the server resolves bundled workflows and the UI
// regardless of the caller's cwd.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(packageRoot, "dist", "server.js");

const [maj] = process.versions.node.split(".").map(Number);
if (maj < 20) {
  console.error(`Mission Control needs Node 20 or newer (you have ${process.versions.node}).`);
  console.error("Install Node 20+ from https://nodejs.org, or run: nvm install 20");
  process.exit(1);
}

const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, HARNESS_PACKAGE_ROOT: packageRoot }
});
const forward = (sig) => () => {
  try {
    child.kill(sig);
  } catch {
    /* child already gone */
  }
};
process.on("SIGINT", forward("SIGINT"));
process.on("SIGTERM", forward("SIGTERM"));
process.on("SIGHUP", forward("SIGHUP"));
child.on("exit", (code) => process.exit(code ?? 0));
