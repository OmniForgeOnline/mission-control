import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** A single native folder-picker invocation candidate. */
export interface PickerCommand {
  command: string;
  args: string[];
}

export type FolderPickResult =
  | { path: string }
  | { canceled: true }
  | { unavailable: true };

const MACOS_PROMPT = "Select a project folder";

const WINDOWS_SCRIPT = [
  "Add-Type -AssemblyName System.Windows.Forms | Out-Null;",
  "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog;",
  `$dialog.Description = '${MACOS_PROMPT}';`,
  "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath }"
].join(" ");

/**
 * Native folder-picker commands to try, in order, for a given platform. The
 * runner tries each until one is installed: this lets Linux fall back from
 * zenity (GNOME) to kdialog (KDE). Returns an empty list for platforms without
 * a known picker so callers can report "unavailable" instead of guessing.
 */
export function pickerCommands(platform: NodeJS.Platform): PickerCommand[] {
  switch (platform) {
    case "darwin":
      return [
        {
          command: "osascript",
          args: ["-e", `POSIX path of (choose folder with prompt "${MACOS_PROMPT}")`]
        }
      ];
    case "win32":
      return [
        {
          command: "powershell",
          args: ["-NoProfile", "-STA", "-Command", WINDOWS_SCRIPT]
        }
      ];
    case "linux":
      return [
        {
          command: "zenity",
          args: ["--file-selection", "--directory", `--title=${MACOS_PROMPT}`]
        },
        {
          command: "kdialog",
          args: ["--getexistingdirectory", homedir()]
        }
      ];
    default:
      return [];
  }
}

/**
 * Extract the chosen absolute path from a picker's stdout. Empty output means
 * the user canceled (uniform across pickers: osascript and zenity also exit
 * non-zero on cancel, PowerShell exits zero with no output).
 */
export function parsePickerOutput(stdout: string): string | null {
  const trimmed = stdout.trim();
  return trimmed.length ? trimmed : null;
}

function isCommandNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT";
}

/**
 * Open a native OS folder picker and resolve to the selected absolute path.
 * Skips pickers that are not installed; a non-zero exit from an installed
 * picker is treated as a cancel (a safe no-op for the caller).
 */
export async function pickFolder(platform: NodeJS.Platform = process.platform): Promise<FolderPickResult> {
  const candidates = pickerCommands(platform);
  if (!candidates.length) return { unavailable: true };

  let sawInstalledPicker = false;
  for (const candidate of candidates) {
    try {
      const { stdout } = await execFileAsync(candidate.command, candidate.args, {
        maxBuffer: 1024 * 1024
      });
      sawInstalledPicker = true;
      const path = parsePickerOutput(stdout);
      return path ? { path } : { canceled: true };
    } catch (error) {
      if (isCommandNotFound(error)) continue;
      // Installed picker exited non-zero (e.g. user canceled or no display).
      return { canceled: true };
    }
  }

  return sawInstalledPicker ? { canceled: true } : { unavailable: true };
}
