import { createNodePtySpawner } from "./node-pty-spawn.ts";
import { createSessionManager, type SessionManager } from "./session-manager.ts";

let singleton: SessionManager | null = null;

/** Process-wide terminal session manager (long-lived PTYs). */
export function getTerminalSessionManager(): SessionManager {
  if (!singleton) {
    singleton = createSessionManager({ spawn: createNodePtySpawner() });
  }
  return singleton;
}

/** Test-only: replace or clear the singleton. */
export function setTerminalSessionManagerForTests(manager: SessionManager | null): void {
  singleton = manager;
}

export function disposeAllTerminalSessions(): void {
  singleton?.disposeAll();
  singleton = null;
}
