import { createRequire } from "node:module";

import type { PtyHandle, PtySpawnOptions, PtySpawner } from "./session-manager.ts";
import { ensureInstalledNodePtySpawnHelpers } from "./spawn-helper.ts";

const require = createRequire(import.meta.url);

interface NodePtyProcess {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
}

interface NodePtyModule {
  spawn(
    file: string,
    args: string[] | string,
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: Record<string, string>;
    }
  ): NodePtyProcess;
}

/**
 * Real node-pty spawner. Isolated so unit tests never import the native addon
 * and the server can fail with a clear message if the binary is missing.
 */
export function createNodePtySpawner(): PtySpawner {
  // node-pty@1.1.0 ships darwin spawn-helper without +x (issue #850).
  ensureInstalledNodePtySpawnHelpers();

  let pty: NodePtyModule;
  try {
    pty = require("node-pty") as NodePtyModule;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to load node-pty (native terminal support). Install build tools ` +
        `(Xcode CLT on macOS, build-essential on Linux) and re-run npm install. ` +
        `Original: ${message}`
    );
  }

  return (opts: PtySpawnOptions): PtyHandle => {
    let proc: NodePtyProcess;
    try {
      proc = pty.spawn(opts.command, opts.args, {
        name: opts.env["TERM"] ?? "xterm-256color",
        cols: opts.cols,
        rows: opts.rows,
        cwd: opts.cwd,
        env: opts.env
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Re-apply permissions once in case install raced or a package manager
      // rewrote the helper after first load, then retry once.
      if (/posix_spawnp/i.test(message)) {
        ensureInstalledNodePtySpawnHelpers();
        try {
          proc = pty.spawn(opts.command, opts.args, {
            name: opts.env["TERM"] ?? "xterm-256color",
            cols: opts.cols,
            rows: opts.rows,
            cwd: opts.cwd,
            env: opts.env
          });
        } catch (retryErr) {
          const retryMessage = retryErr instanceof Error ? retryErr.message : String(retryErr);
          throw new Error(
            `Failed to open PTY (${retryMessage}). On macOS this is often a non-executable ` +
              `node-pty spawn-helper; run: chmod +x node_modules/node-pty/prebuilds/*/spawn-helper`
          );
        }
      } else {
        throw err instanceof Error ? err : new Error(message);
      }
    }

    let cols = opts.cols;
    let rows = opts.rows;

    return {
      get pid() {
        return proc.pid;
      },
      get cols() {
        return cols;
      },
      get rows() {
        return rows;
      },
      write(data: string) {
        proc.write(data);
      },
      resize(nextCols: number, nextRows: number) {
        proc.resize(nextCols, nextRows);
        cols = nextCols;
        rows = nextRows;
      },
      kill(signal = "SIGTERM") {
        try {
          proc.kill(signal);
        } catch {
          /* already dead */
        }
      },
      onData(cb) {
        proc.onData(cb);
      },
      onExit(cb) {
        proc.onExit(({ exitCode, signal }) => {
          cb({
            exitCode,
            ...(signal !== undefined ? { signal } : {})
          });
        });
      }
    };
  };
}
