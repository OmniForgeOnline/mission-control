/**
 * Registry of desktop coding editors the operator can hand a ticket worktree off to.
 *
 * Add an editor by appending to {@link SUPPORTED_EDITORS}. The UI dropdown and the
 * `/api/state` catalog derive from this list, so no other wiring is required.
 */

/** Stable id persisted nowhere; carried in the open-in-editor request body. */
export type EditorId = "vscode" | "cursor" | "codex" | "kiro";

export interface EditorApp {
  readonly id: EditorId;
  /** Label shown in the ticket dropdown. */
  readonly label: string;
  /**
   * macOS application name passed to `open -a`. Required for editors launched through
   * the generic app opener; omit when {@link darwinWorkspaceCommand} drives the launch.
   */
  readonly darwinAppName?: string;
  /**
   * Per-editor Darwin launcher used when `open -a <app> <folder>` cannot open the
   * workspace. The running Codex app, for example, ignores that folder argument and
   * only switches workspaces through its `codex app <path>` subcommand, so the
   * worktree must be handed off via that command instead. The worktree path is
   * appended to `args`.
   */
  readonly darwinWorkspaceCommand?: { readonly command: string; readonly args: readonly string[] };
  /** CLI binary used on non-Darwin platforms (`open -a` is Darwin-only). */
  readonly cliCommand?: string;
}

export const SUPPORTED_EDITORS: readonly EditorApp[] = [
  { id: "vscode", label: "VS Code", darwinAppName: "Visual Studio Code", cliCommand: "code" },
  { id: "cursor", label: "Cursor", darwinAppName: "Cursor", cliCommand: "cursor" },
  {
    id: "codex",
    label: "Codex",
    // The running Codex desktop app ignores the folder argument of `open -a`, so
    // hand the worktree to its workspace subcommand instead. Off macOS, `codex` is
    // the terminal agent CLI rather than a desktop-app launcher; do not wire a CLI
    // fallback, or the detached, stdio-ignored handoff silently opens nothing usable.
    // Non-Darwin surfaces a 409 via buildLaunchCommand instead.
    darwinWorkspaceCommand: { command: "codex", args: ["app"] }
  },
  { id: "kiro", label: "Kiro", darwinAppName: "Kiro", cliCommand: "kiro" }
];

const EDITOR_IDS: ReadonlySet<string> = new Set(SUPPORTED_EDITORS.map((editor) => editor.id));

export function getEditor(id: string): EditorApp | undefined {
  return SUPPORTED_EDITORS.find((editor) => editor.id === id);
}

export function isEditorId(value: unknown): value is EditorId {
  return typeof value === "string" && EDITOR_IDS.has(value);
}

/** `{ id, label }` projection surfaced to the UI via `/api/state`. */
export function editorSummaries(): Array<{ id: EditorId; label: string }> {
  return SUPPORTED_EDITORS.map((editor) => ({ id: editor.id, label: editor.label }));
}

export interface LaunchCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * Build the spawn argv that opens `worktreePath` in `editor`. Pure and side-effect
 * free so launch strategies stay unit-testable without spawning real processes.
 *
 * Darwin launches the desktop application by name (`open -a`), or through the
 * editor's own workspace subcommand when it defines one; other platforms fall back
 * to the editor's CLI binary. Throws when none applies.
 */
export function buildLaunchCommand(
  editor: EditorApp,
  platform: NodeJS.Platform,
  worktreePath: string
): LaunchCommand {
  if (platform === "darwin") {
    const ws = editor.darwinWorkspaceCommand;
    if (ws) {
      return { command: ws.command, args: [...ws.args, worktreePath] };
    }
    if (editor.darwinAppName) {
      return { command: "open", args: ["-a", editor.darwinAppName, worktreePath] };
    }
    throw new Error(`${editor.label} is not supported on ${platform}.`);
  }
  if (editor.cliCommand) {
    return { command: editor.cliCommand, args: [worktreePath] };
  }
  throw new Error(`${editor.label} is not supported on ${platform}.`);
}
