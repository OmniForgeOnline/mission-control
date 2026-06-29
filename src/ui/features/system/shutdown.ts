import { api } from "@ui/data/api.js";
import { ui } from "@ui/app/state.js";

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
  // The per-server token arrives via boot state (/api/state); echo it in a
  // non-simple header. A cross-site form POST cannot set a custom header (and
  // would fail any CORS preflight), so carrying the token here is what closes
  // the CSRF vector on the loopback listener.
  const token = ui.data?.shutdownToken ?? "";
  await api("/api/shutdown", {
    method: "POST",
    headers: { "content-type": "application/json", "x-shutdown-token": token }
  });
}
