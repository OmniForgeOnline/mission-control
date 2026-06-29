#!/usr/bin/env node
// Detached self-updater for @omniforge/mission-control.
//
// Spawned (detached, unref'd) by the server just before it exits, then
// reparented to PID 1 when the server goes down. It:
//   1. waits for the server process to exit,
//   2. runs `npm install -g <package>@latest`,
//   3. picks a launch root (the freshly installed package on success, else the
//      currently installed one so the app always comes back),
//   4. records the outcome to MC_UPDATE_STATUS_FILE, and
//   5. re-launches the server detached.
//
// This file is plain ESM (no TypeScript) on purpose: it runs under plain Node
// after the package directory may have been replaced by the install. It is
// copied to a temp file before launch so it is not deleted mid-run.
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  writeSync
} from "node:fs";
import path from "node:path";

const env = process.env;
const PKG = env.MC_UPDATE_PACKAGE;
const ORIG_ROOT = env.MC_UPDATE_ORIG_ROOT;
const HARNESS_ROOT = env.MC_UPDATE_HARNESS_ROOT;
const STATUS_FILE = env.MC_UPDATE_STATUS_FILE;
const FROM_VERSION = env.MC_UPDATE_FROM_VERSION ? env.MC_UPDATE_FROM_VERSION : null;
const PARENT_PID = Number(env.MC_UPDATE_PARENT_PID);
const PORT = env.MC_UPDATE_PORT ? env.MC_UPDATE_PORT : "";
const HOST = env.MC_UPDATE_HOST ? env.MC_UPDATE_HOST : "";

const logFile = HARNESS_ROOT ? path.join(HARNESS_ROOT, ".mission-control", "update-relaunch.log") : null;

function log(line) {
  if (!logFile) return;
  try {
    mkdirSync(path.dirname(logFile), { recursive: true });
    const fd = openSync(logFile, "a");
    try {
      writeSync(fd, Buffer.from(`[${new Date().toISOString()}] ${line}\n`, "utf8"));
    } finally {
      closeSync(fd);
    }
  } catch {
    /* best-effort logging */
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run(cmd, args, timeoutMs = 300_000) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      env,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      stdout += d;
    });
    child.stderr?.on("data", (d) => {
      stderr += d;
    });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}${String(err)}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

function writeStatus(out) {
  if (!STATUS_FILE) return;
  try {
    mkdirSync(path.dirname(STATUS_FILE), { recursive: true });
    writeFileSync(STATUS_FILE, JSON.stringify(out));
  } catch {
    /* status is best-effort */
  }
}

function readVersion(pkgRoot) {
  try {
    const parsed = JSON.parse(readFileSync(path.join(pkgRoot, "package.json"), "utf8"));
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

async function waitForParent(pid, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await sleep(200);
  }
  return false;
}

async function npmPrefix() {
  const res = await run("npm", ["config", "get", "prefix"], 30_000);
  return res.code === 0 ? res.stdout.trim() : "";
}

async function main() {
  if (!PKG || !ORIG_ROOT) {
    log("apply-update: missing MC_UPDATE_PACKAGE or MC_UPDATE_ORIG_ROOT; aborting");
    process.exit(0);
  }

  log(`apply-update start: ${PKG} from ${FROM_VERSION ?? "unknown"}`);

  if (PARENT_PID) {
    const gone = await waitForParent(PARENT_PID, 20_000);
    log(gone ? "parent server exited" : "parent still alive after 20s; proceeding");
  }

  const install = await run("npm", ["install", "-g", `${PKG}@latest`], 300_000);
  log(`npm install exit=${install.code}; stderr tail=${install.stderr.slice(-300)}`);

  let launchRoot = ORIG_ROOT;
  let toVersion = null;
  if (install.code === 0) {
    const prefix = await npmPrefix();
    const candidate = prefix ? path.join(prefix, "lib", "node_modules", PKG) : "";
    if (candidate && existsSync(path.join(candidate, "dist", "server.js"))) {
      launchRoot = candidate;
      toVersion = readVersion(candidate);
    } else {
      // Installed but the new entry is not where we expect; relaunch the
      // current install so the app stays alive.
      launchRoot = ORIG_ROOT;
      log(`install ok but launch entry not found at ${candidate || "(no prefix)"}; falling back`);
    }
  } else {
    const message =
      `Global install failed (exit ${install.code}). ` +
      `Run manually: npm install -g ${PKG}@latest. ` +
      install.stderr.slice(0, 300);
    writeStatus({ result: "failed", from: FROM_VERSION, to: null, at: new Date().toISOString(), message });
    log(message);
    launchRoot = ORIG_ROOT;
  }

  if (install.code === 0) {
    writeStatus({ result: "ok", from: FROM_VERSION, to: toVersion, at: new Date().toISOString() });
  }

  const entry = path.join(launchRoot, "dist", "server.js");
  if (!existsSync(entry)) {
    log(`no server entry at ${entry}; cannot relaunch`);
    process.exit(0);
  }

  const childEnv = { ...env, HARNESS_PACKAGE_ROOT: launchRoot };
  if (HARNESS_ROOT) childEnv.HARNESS_ROOT = HARNESS_ROOT;
  if (PORT) childEnv.PORT = PORT;
  if (HOST) childEnv.HARNESS_HOST = HOST;

  let stdio = "ignore";
  let logFd = -1;
  if (logFile) {
    try {
      mkdirSync(path.dirname(logFile), { recursive: true });
      logFd = openSync(logFile, "a");
      stdio = ["ignore", logFd, logFd];
    } catch {
      stdio = "ignore";
    }
  }

  try {
    const child = spawn(process.execPath, [entry], { detached: true, stdio, env: childEnv });
    child.unref();
    log(`relaunched ${entry} (pid ${child.pid})`);
  } catch (err) {
    log(`relaunch failed: ${String(err)}`);
    if (install.code === 0) {
      writeStatus({
        result: "ok",
        from: FROM_VERSION,
        to: toVersion,
        at: new Date().toISOString(),
        message: `Installed ${toVersion ?? ""} but automatic restart failed. Run "mission-control" to start the new version.`
      });
    }
  } finally {
    if (logFd !== -1) {
      try {
        closeSync(logFd);
      } catch {
        /* ignore */
      }
    }
  }

  process.exit(0);
}

main().catch((err) => {
  log(`apply-update error: ${String(err && err.stack ? err.stack : err)}`);
  process.exit(1);
});
