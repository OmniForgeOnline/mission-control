import type { StateScope } from "@ui/app/scopes.js";
import { includesScope } from "@ui/app/scopes.js";
import { pollActiveTails } from "@ui/features/runs/tail/poll.js";

type StateChangeHandler = (scopes: StateScope[]) => void;
type ConnectionHandler = (connected: boolean) => void;

let source: EventSource | null = null;
let handler: StateChangeHandler | null = null;
let connectionHandler: ConnectionHandler | null = null;
let reconnectTimer: number | null = null;
let reconnectAttempt = 0;
let connected = false;
let hadConnectedOnce = false;

const MAX_RECONNECT_MS = 30_000;

export function onConnectionChange(listener: ConnectionHandler): void {
  connectionHandler = listener;
  listener(connected);
}

function setConnected(next: boolean): void {
  if (connected === next) return;
  connected = next;
  connectionHandler?.(next);
  document.dispatchEvent(
    new CustomEvent("harness:events-status", { detail: { connected: next } })
  );
}

function scheduleReconnect(): void {
  setConnected(false);
  if (reconnectTimer !== null) return;
  const delay = Math.min(MAX_RECONNECT_MS, 1000 * 2 ** reconnectAttempt);
  reconnectAttempt += 1;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    openSource();
  }, delay);
}

function handleStateChanged(event: Event): void {
  try {
    const payload = JSON.parse((event as MessageEvent).data) as { scopes?: StateScope[] };
    const scopes = payload.scopes ?? ["all"];
    if (includesScope(scopes, "all") || includesScope(scopes, "runs")) {
      pollActiveTails();
    }
    handler?.(scopes);
  } catch {
    handler?.(["all"]);
  }
}

function openSource(): void {
  if (source) {
    source.close();
    source = null;
  }

  const next = new EventSource("/api/events");
  source = next;

  next.addEventListener("open", () => {
    const wasDisconnected = hadConnectedOnce && !connected;
    reconnectAttempt = 0;
    setConnected(true);
    hadConnectedOnce = true;
    if (wasDisconnected) handler?.(["all"]);
  });

  next.addEventListener("state-changed", handleStateChanged);

  next.addEventListener("error", () => {
    next.close();
    if (source === next) source = null;
    scheduleReconnect();
  });
}

export function connectStateEvents(onChange: StateChangeHandler): void {
  handler = onChange;
  if (source) return;
  openSource();
}