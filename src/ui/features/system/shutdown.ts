import { api } from "@ui/data/api.js";

/**
 * UI-side shutdown. The control is gated behind a confirmation modal built from
 * `SHUTDOWN_WARNING`; only after the operator confirms does `requestShutdown`
 * hit the shared backend path (POST /api/shutdown), which terminates every
 * running process and takes the UI offline.
 */

export const SHUTDOWN_WARNING = {
  title: "Shut down Mission Control?",
  message:
    "All running processes will be terminated and the UI will become unavailable until the app is restarted from the terminal. " +
    "Restart it by running `mission-control` again.",
  confirmLabel: "Shut down",
  cancelLabel: "Cancel"
} as const;

/** Ask the backend to begin graceful shutdown (shared with Ctrl+C and the CLI). */
export async function requestShutdown(): Promise<void> {
  await api("/api/shutdown", { method: "POST" });
}
