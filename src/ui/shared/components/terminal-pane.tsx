import { useEffect, useRef, useState } from "preact/hooks";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
// @ts-expect-error CSS side-effect import (Vite handles this at build time)
import "@xterm/xterm/css/xterm.css";

import { api } from "@ui/data/api.js";
import { errorToast } from "@ui/overlays/toast.js";

export interface TerminalSessionInfo {
  id: string;
  taskId?: string;
  runId?: string;
  label?: string;
  command: string;
  cwd: string;
  cols: number;
  rows: number;
  alive: boolean;
  createdAt: string;
  exitCode: number | null;
}

interface TerminalPaneProps {
  taskId: string;
  /**
   * Session created by the daemon interactive runner. When absent, the pane
   * shows a waiting state (no free-floating shell/TUI spawn).
   */
  sessionId?: string;
  /** True while this workflow step is the active turn. */
  active?: boolean;
}

function wsUrl(sessionId: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/api/terminal/ws?sessionId=${encodeURIComponent(sessionId)}`;
}

/**
 * Operator surface for daemon-owned interactive agent turns. Attaches to the
 * existing PTY session; never spawns a second unrelated shell/TUI.
 */
export function TerminalPane({ sessionId, active = false }: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const sessionRef = useRef<string | null>(null);
  const [session, setSession] = useState<TerminalSessionInfo | null>(null);
  const [status, setStatus] = useState<"waiting" | "connecting" | "live" | "exited" | "error">("waiting");

  function disposeSocket(): void {
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  }

  function disposeTerm(): void {
    disposeSocket();
    termRef.current?.dispose();
    termRef.current = null;
    fitRef.current = null;
  }

  useEffect(() => {
    return () => disposeTerm();
  }, []);

  function ensureTerm(): Terminal {
    if (termRef.current) return termRef.current;
    if (!hostRef.current) throw new Error("Terminal host not mounted");
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      theme: {
        background: "#0d1117",
        foreground: "#e6edf3",
        cursor: "#e6edf3",
        selectionBackground: "#264f78"
      },
      allowProposedApi: true
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;
    term.onData((data) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "input", data }));
      }
    });
    return term;
  }

  function attach(id: string): void {
    disposeSocket();
    const term = ensureTerm();
    const fit = fitRef.current;
    setStatus("connecting");

    const ws = new WebSocket(wsUrl(id));
    wsRef.current = ws;
    sessionRef.current = id;

    ws.onopen = () => {
      setStatus("live");
      fit?.fit();
      if (term && fit) {
        const dims = fit.proposeDimensions();
        if (dims) {
          ws.send(JSON.stringify({ type: "resize", cols: dims.cols, rows: dims.rows }));
        }
      }
    };

    ws.onmessage = (event) => {
      let msg: { type: string; data?: string; message?: string; code?: number | null };
      try {
        msg = JSON.parse(String(event.data)) as typeof msg;
      } catch {
        return;
      }
      if (msg.type === "output" && typeof msg.data === "string") {
        term.write(msg.data);
      } else if (msg.type === "exit") {
        setStatus("exited");
        setSession((prev) => (prev ? { ...prev, alive: false, exitCode: msg.code ?? null } : prev));
      } else if (msg.type === "error" && msg.message) {
        setStatus("error");
        errorToast(msg.message);
      }
    };

    ws.onclose = () => {
      if (sessionRef.current === id) {
        setStatus((s) => (s === "exited" ? s : "waiting"));
      }
    };

    ws.onerror = () => {
      setStatus("error");
    };
  }

  // Auto-attach to the daemon session for this task (reattach on reconnect).
  useEffect(() => {
    if (!sessionId) {
      disposeSocket();
      sessionRef.current = null;
      setSession(null);
      setStatus("waiting");
      return;
    }
    if (sessionRef.current === sessionId && wsRef.current) return;
    let cancelled = false;
    void (async () => {
      try {
        const info = await api<TerminalSessionInfo>(`/api/terminal/sessions/${sessionId}`);
        if (cancelled || !info) return;
        setSession(info);
        requestAnimationFrame(() => {
          if (!cancelled) attach(info.id);
        });
      } catch (err) {
        if (!cancelled) {
          setStatus("error");
          errorToast((err as Error).message);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ro = new ResizeObserver(() => {
      const fit = fitRef.current;
      const term = termRef.current;
      const ws = wsRef.current;
      if (!fit || !term) return;
      fit.fit();
      const dims = fit.proposeDimensions();
      if (dims && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols: dims.cols, rows: dims.rows }));
      }
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, [session?.id, sessionId]);

  const statusLabel =
    status === "live"
      ? "live"
      : status === "connecting"
        ? "connecting…"
        : status === "exited"
          ? "exited"
          : status === "error"
            ? "error"
            : active
              ? "starting…"
              : "idle";

  return (
    <div class="term-pane is-daemon">
      <div class="term-host-wrap">
        <span class={`term-status is-${status === "waiting" ? "connecting" : status}`}>{statusLabel}</span>
        {!sessionId && active ? (
          <div class="term-waiting muted">Starting interactive agent session…</div>
        ) : null}
        <div class={`term-host${sessionId ? "" : " is-empty"}`} ref={hostRef} />
      </div>
    </div>
  );
}
