import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";

import type { HarnessTask } from "../types.ts";
import { worktreePathFor } from "../worktrees/worktrees.ts";
import { buildLaunchCommand, getEditor, type EditorId } from "./registry.ts";

/**
 * Awaitable launcher. Injectable so tests never spawn real editors. Rejects when the
 * editor cannot be dispatched (missing binary, non-zero exit) so the route surfaces a
 * 409 instead of reporting a success that never opened anything.
 */
export type EditorSpawner = (command: string, args: readonly string[]) => Promise<void>;

export interface LaunchEditorResult {
  readonly editorId: EditorId;
  readonly editorLabel: string;
  /** Harness-resolved worktree path the editor was pointed at. */
  readonly worktreePath: string;
  readonly command: string;
  readonly args: readonly string[];
}

export interface LaunchEditorParams {
  readonly root: string;
  readonly task: HarnessTask;
  readonly editorId: string;
  readonly platform?: NodeJS.Platform;
  readonly spawn?: EditorSpawner;
}

/**
 * Spawn a desktop editor pointed at the worktree the harness prepared for `task`.
 *
 * The worktree path is resolved server-side from the task via {@link worktreePathFor}
 * (the same function the agent runtime uses), never from client input. Launches only
 * when that directory exists; otherwise throws so the route can surface a 409.
 */
export async function launchEditorForTask(params: LaunchEditorParams): Promise<LaunchEditorResult> {
  const editor = getEditor(params.editorId);
  if (!editor) {
    throw new Error(`Unsupported editor: ${params.editorId}`);
  }

  const worktreePath = worktreePathFor(params.root, params.task);
  const info = await stat(worktreePath).catch(() => null);
  if (!info?.isDirectory()) {
    throw new Error("No worktree found for this ticket.");
  }

  const { command, args } = buildLaunchCommand(editor, params.platform ?? process.platform, worktreePath);
  await (params.spawn ?? defaultEditorSpawn)(command, args);
  return {
    editorId: editor.id,
    editorLabel: editor.label,
    worktreePath,
    command,
    args
  };
}

/**
 * Dispatch window long enough for `open`/CLI launchers to surface a spawn error or
 * early non-zero exit, but short enough that a launcher which legitimately stays
 * alive (a blocking CLI) cannot hang the handoff request. Real launchers exit in
 * well under a second either way, so the happy path settles immediately.
 */
const DISPATCH_GRACE_MS = 3_000;

/**
 * Spawns the editor detached so it outlives the server, but awaits the launcher's
 * outcome before resolving. Spawn failures and early non-zero exits reject, so the
 * route reports a 409 rather than a success that never opened an editor. If the
 * launcher is still running once it has had ample time to fail, we treat the dispatch
 * as successful: the editor started and is simply holding the process open.
 */
export const defaultEditorSpawn: EditorSpawner = (command, args) =>
  new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(grace);
      action();
    };
    const child = spawn(command, [...args], { detached: true, stdio: "ignore" });
    child.on("error", (error) =>
      finish(() => reject(new Error(`Could not launch editor: ${error.message}`)))
    );
    child.on("exit", (code) =>
      finish(() => {
        if (code === 0) resolve();
        else reject(new Error(`Editor command exited with code ${code ?? "unknown"}.`));
      })
    );
    const grace = setTimeout(() => finish(resolve), DISPATCH_GRACE_MS);
    child.unref();
  });
