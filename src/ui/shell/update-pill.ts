import { api } from "@ui/data/api.js";
import { $, escapeHtml } from "@ui/shell/dom.js";
import { bindDialogDismiss } from "@ui/overlays/dialog.js";
import { toast } from "@ui/overlays/toast.js";
import { icon } from "@ui/shell/icons.js";

interface UpdateOutcome {
  result: "ok" | "failed";
  from: string | null;
  to: string | null;
  at: string;
  message?: string;
}

export interface VersionStatus {
  installed: string | null;
  latest: string | null;
  behind: boolean;
  fetchedAt: string | null;
  canSelfUpdate: boolean;
  lastUpdate: UpdateOutcome | null;
}

/** Pure model the header pill renders from. Pinned by tests. */
export interface UpdatePillModel {
  visible: boolean;
  latest: string | null;
  canSelfUpdate: boolean;
}

export function updatePillModel(s: VersionStatus | null): UpdatePillModel {
  if (!s) return { visible: false, latest: null, canSelfUpdate: false };
  return { visible: s.behind, latest: s.latest, canSelfUpdate: s.canSelfUpdate };
}

let status: VersionStatus | null = null;
let pollTimer: number | null = null;
const POLL_MS = 10 * 60 * 1000;
const toastedAt = new Set<string>();

/** Markup for the update pill, empty when the install is current. */
export function updatePillHtml(): string {
  const model = updatePillModel(status);
  if (!model.visible) return "";
  const target = model.latest ? escapeHtml(model.latest) : "latest";
  return `<button class="update-pill" id="updatePill" type="button" title="A newer Mission Control is available" aria-label="Update Mission Control to version ${target}">
    ${icon("arrow-up", 12)}
    <span>Update to v${target}</span>
  </button>`;
}

/** Wire the pill click after renderAppBar rebuilds the bar. */
export function bindUpdatePill(): void {
  $("#updatePill")?.addEventListener("click", () => {
    if (status) openUpdateModal(status);
  });
}

function updateDialog(): HTMLDialogElement | null {
  return $("#updateDialog") as HTMLDialogElement | null;
}

function setModalStatus(message: string): void {
  const el = $("#updateModalStatus");
  if (!el) return;
  el.hidden = false;
  el.textContent = message;
}

export function openUpdateModal(s: VersionStatus): void {
  const dlg = updateDialog();
  if (!dlg) return;
  const from = escapeHtml(s.installed ?? "current");
  const to = escapeHtml(s.latest ?? "latest");
  const canNow = s.canSelfUpdate;
  const disabled = canNow ? "" : "disabled";
  dlg.innerHTML = `
    <div class="update-panel" role="dialog" aria-labelledby="updateTitle">
      <h2 id="updateTitle" class="update-title">Update Mission Control</h2>
      <p class="update-message">A newer version is available: <strong>${from}</strong> &rarr; <strong>${to}</strong>.</p>
      <p class="update-hint">Updating installs the new version and restarts the app.</p>
      <div class="update-actions">
        <button class="btn btn-ghost" type="button" id="updateCancel">Not now</button>
        <button class="btn btn-ghost" type="button" id="updateIdle" ${disabled}>Update when idle</button>
        <button class="btn btn-primary" type="button" id="updateNow" ${disabled}>Update now</button>
      </div>
      <p class="update-status" id="updateModalStatus" hidden></p>
    </div>
  `;
  bindDialogDismiss(dlg);
  $("#updateCancel")?.addEventListener("click", () => dlg.close());
  $("#updateNow")?.addEventListener("click", () => void applyFromModal("now"));
  $("#updateIdle")?.addEventListener("click", () => void applyFromModal("idle"));
  dlg.showModal();
}

async function applyFromModal(mode: "now" | "idle"): Promise<void> {
  const nowBtn = $("#updateNow") as HTMLButtonElement | null;
  const idleBtn = $("#updateIdle") as HTMLButtonElement | null;
  if (nowBtn) nowBtn.disabled = true;
  if (idleBtn) idleBtn.disabled = true;

  if (mode === "idle") {
    setModalStatus("Queued. Mission Control will install and restart when the system is idle.");
  } else {
    setModalStatus("Stopping active work and installing...");
  }

  try {
    const res = await api<{ applying?: boolean; queued?: boolean }>("/api/update/apply", {
      method: "POST",
      body: JSON.stringify({ mode })
    });
    if (mode === "idle" && res?.queued) {
      const dlg = updateDialog();
      if (dlg) dlg.close();
      return;
    }
    if (mode === "now" && res?.applying) {
      setModalStatus("Installed. Restarting...");
      void awaitServerRestart({
        probe: probeVersionStatus,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        now: () => Date.now(),
        reload: () => window.location.reload(),
        onTimeout: () =>
          setModalStatus("Restart is taking longer than expected. Refresh the page to continue.")
      });
    }
  } catch (error) {
    setModalStatus(`Failed: ${(error as Error).message}`);
    if (nowBtn) nowBtn.disabled = false;
    if (idleBtn) idleBtn.disabled = false;
  }
}

/** Resolve the version status when the server answers, null on any network failure. */
async function probeVersionStatus(): Promise<VersionStatus | null> {
  try {
    return await api<VersionStatus>("/api/version");
  } catch {
    return null;
  }
}

/** Injectable dependencies so the restart watcher is testable without a browser. */
export interface RestartWatcherDeps {
  /** Resolve the version status when the server answers, null on any network failure. */
  probe: () => Promise<VersionStatus | null>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  reload: () => void;
  /** Called when no restart is observed before the deadline. */
  onTimeout: () => void;
}

const RESTART_INTERVAL_MS = 1500;
// Exceeds the detached updater's 5-min `npm install` cap plus boot, so a slow
// install still recovers instead of falling back to the manual-refresh message.
const RESTART_TIMEOUT_MS = 6 * 60 * 1000;

/**
 * After "Update now" returns `applying: true`, watch for the update to complete
 * and reload the page so the freshly installed client bundle is loaded.
 *
 * Completion is read from state, not inferred from an outage: the detached
 * updater writes a fresh `lastUpdate` outcome to disk *before* it relaunches
 * the server, so the moment the new server answers `/api/version` it reports a
 * `lastUpdate.at` newer than the one captured here as the baseline. Detecting
 * that fresh outcome reloads correctly even when the restart falls entirely
 * between two probes (which an outage-based check would miss). Falls back to
 * `onTimeout` when no fresh outcome appears within the deadline, so the UI
 * never sits on a "Restarting..." promise it cannot fulfill.
 */
export async function awaitServerRestart(
  deps: RestartWatcherDeps,
  intervalMs = RESTART_INTERVAL_MS,
  timeoutMs = RESTART_TIMEOUT_MS
): Promise<void> {
  const deadline = deps.now() + timeoutMs;
  const baselineAt = (await deps.probe())?.lastUpdate?.at ?? null;
  while (deps.now() < deadline) {
    await deps.sleep(intervalMs);
    const outcome = (await deps.probe())?.lastUpdate;
    if (outcome && outcome.result === "ok" && outcome.at !== baselineAt) {
      deps.reload();
      return;
    }
  }
  deps.onTimeout();
}

function toastOutcome(outcome: UpdateOutcome): void {
  if (outcome.result === "ok") {
    toast(outcome.to ? `Mission Control updated to ${outcome.to}.` : "Mission Control updated.", {
      tone: "success"
    });
  } else {
    toast(outcome.message ?? "Mission Control update failed.", { tone: "error", persistent: true });
  }
}

export async function pollVersionStatus(): Promise<void> {
  try {
    const next = await api<VersionStatus>("/api/version");
    if (!next) return;
    const wasVisible = status ? status.behind : false;
    status = next;
    if (next.lastUpdate && !toastedAt.has(next.lastUpdate.at)) {
      toastedAt.add(next.lastUpdate.at);
      toastOutcome(next.lastUpdate);
    }
    if (wasVisible !== next.behind) {
      document.dispatchEvent(new CustomEvent("harness:refresh-render"));
    }
  } catch {
    // Network or server hiccup: keep the last known status and try again later.
  }
}

export function startVersionPolling(): void {
  if (pollTimer !== null) return;
  void pollVersionStatus();
  pollTimer = window.setInterval(() => {
    void pollVersionStatus();
  }, POLL_MS);
}
