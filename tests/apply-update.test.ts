import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { updateStatusPath } from "../src/core/system/update.ts";

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, "..", "scripts", "apply-update.mjs");
const PKG = "@omniforge/mission-control";

// The updater resolves the new install under `<prefix>/lib/node_modules/<pkg>`
// and spawns `npm` (resolved via PATH) without a shell. Both are unix-shaped,
// so the end-to-end run is skipped on Windows.
const maybe = process.platform === "win32" ? describe.skip : describe;

// Minimal fake `npm`, placed first on PATH: it answers `config get prefix`
// from an env var and exits `install` with a configurable code. This lets the
// test drive the real updater script without touching the real registry.
const FAKE_NPM = `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a[0] === "config" && a[1] === "get" && a[2] === "prefix") {
  process.stdout.write(process.env.MC_FAKE_PREFIX || "");
  process.exit(0);
}
if (a[0] === "install") process.exit(Number(process.env.MC_FAKE_INSTALL_EXIT ?? "0"));
process.exit(0);
`;

interface UpdaterStatus {
  result: "ok" | "failed";
  from?: string | null;
  to?: string | null;
  at?: string;
  message?: string;
}

async function readStatus(file: string): Promise<UpdaterStatus | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as UpdaterStatus;
  } catch {
    return null;
  }
}

maybe("apply-update.mjs detached updater", () => {
  let workspace: string;
  let origRoot: string;
  let harnessRoot: string;
  let prefix: string;
  let binDir: string;
  let statusFile: string;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), "mc-apply-update-"));
    origRoot = path.join(workspace, "orig");
    harnessRoot = path.join(workspace, "harness");
    prefix = path.join(workspace, "prefix");
    binDir = path.join(workspace, "bin");
    await mkdir(path.join(origRoot, "dist"), { recursive: true });
    // The updater relaunches <launchRoot>/dist/server.js detached; keep it a
    // no-op so that child exits immediately rather than starting a real server.
    await writeFile(path.join(origRoot, "dist", "server.js"), "process.exit(0)\n");
    await mkdir(path.join(harnessRoot, ".mission-control"), { recursive: true });
    await mkdir(prefix, { recursive: true });
    await mkdir(binDir, { recursive: true });
    await writeFile(path.join(binDir, "npm"), FAKE_NPM);
    await chmod(path.join(binDir, "npm"), 0o755);
    statusFile = updateStatusPath(harnessRoot);
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  async function runUpdater(opts: { installExit: number; withCandidate?: boolean }): Promise<void> {
    if (opts.withCandidate) {
      const candidate = path.join(prefix, "lib", "node_modules", PKG);
      await mkdir(path.join(candidate, "dist"), { recursive: true });
      await writeFile(path.join(candidate, "dist", "server.js"), "process.exit(0)\n");
      await writeFile(path.join(candidate, "package.json"), JSON.stringify({ version: "9.9.9" }));
    }
    // MC_UPDATE_PARENT_PID is deliberately omitted: Number(undefined) is NaN,
    // so the parent-wait is skipped and the updater proceeds immediately.
    const env: NodeJS.ProcessEnv = {
      PATH: `${binDir}${path.delimiter}${process.env["PATH"] ?? ""}`,
      MC_UPDATE_PACKAGE: PKG,
      MC_UPDATE_ORIG_ROOT: origRoot,
      MC_UPDATE_HARNESS_ROOT: harnessRoot,
      MC_UPDATE_STATUS_FILE: statusFile,
      MC_UPDATE_FROM_VERSION: "0.0.1",
      MC_FAKE_PREFIX: prefix,
      MC_FAKE_INSTALL_EXIT: String(opts.installExit)
    };
    await run(process.execPath, [SCRIPT], { env, timeout: 15_000 });
  }

  it("records ok with the resolved version when the new entry is present", async () => {
    await runUpdater({ installExit: 0, withCandidate: true });
    const status = await readStatus(statusFile);
    expect(status).toMatchObject({ result: "ok", from: "0.0.1", to: "9.9.9" });
  });

  it("records failed (not ok) when install succeeds but the new entry is missing", async () => {
    // Regression guard for the misleading-success bug: install exits 0 but the
    // new package root cannot be resolved, so the current install is relaunched.
    // The recorded outcome must NOT claim the update succeeded.
    await runUpdater({ installExit: 0 });
    const status = await readStatus(statusFile);
    expect(status?.result).toBe("failed");
    expect(status?.to).toBeNull();
    expect(typeof status?.message).toBe("string");
    expect((status?.message as string).length).toBeGreaterThan(0);
  });

  it("records failed when the global install itself fails", async () => {
    await runUpdater({ installExit: 1 });
    const status = await readStatus(statusFile);
    expect(status?.result).toBe("failed");
    expect(status?.to).toBeNull();
  });
});
