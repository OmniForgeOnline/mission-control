import { useEffect, useRef, useState } from "preact/hooks";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";

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
  /**
   * Session created by the daemon interactive runner. When absent, the pane
   * shows a waiting state (no free-floating shell/TUI spawn).
   */
  sessionId?: string | undefined;
  /** True while this workflow step is the active turn. */
  active?: boolean | undefined;
  /**
   * Once the WS is live, type this into the interactive shell once
   * (Settings Install / Login bootstrap). Trailing newline is added.
   */
  bootstrapCommand?: string | undefined;
}

type XtermBundle = {
  Terminal: typeof Terminal;
  FitAddon: typeof FitAddon;
};

/** Load xterm only when an interactive session attaches — keeps the main bundle lean. */
let xtermBundle: Promise<XtermBundle> | null = null;

/** Ensure xterm CSS is in the document (lazy, once). Vite rewrites the URL at build time. */
function ensureXtermCss(): void {
  const id = "xterm-stylesheet";
  if (document.getElementById(id)) return;
  const link = document.createElement("link");
  link.id = id;
  link.rel = "stylesheet";
  link.href = new URL("../../styles/xterm.css", import.meta.url).href;
  document.head.appendChild(link);
}

function loadXterm(): Promise<XtermBundle> {
  if (!xtermBundle) {
    xtermBundle = (async () => {
      ensureXtermCss();
      const [xterm, fit] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit")
      ]);
      return { Terminal: xterm.Terminal, FitAddon: fit.FitAddon };
    })();
  }
  return xtermBundle;
}

function wsUrl(sessionId: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/api/terminal/ws?sessionId=${encodeURIComponent(sessionId)}`;
}

/**
 * Operator surface for daemon-owned interactive agent turns. Attaches to the
 * existing PTY session; never spawns a second unrelated shell/TUI.
 */
export function TerminalPane({ sessionId, active = false, bootstrapCommand }: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const sessionRef = useRef<string | null>(null);
  const bootstrappedRef = useRef<string | null>(null);
  const bootstrapRef = useRef(bootstrapCommand);
  bootstrapRef.current = bootstrapCommand;
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

  async function ensureTerm(): Promise<Terminal> {
    if (termRef.current) return termRef.current;
    const { Terminal: Term, FitAddon: Fit } = await loadXterm();
    if (termRef.current) return termRef.current;
    if (!hostRef.current) throw new Error("Terminal host not mounted");
    const termBg =
      getComputedStyle(document.documentElement).getPropertyValue("--term-bg").trim() || "#0a0b0e";
    const term = new Term({
      cursorBlink: true,
      fontSize: window.matchMedia("(max-width: 720px)").matches ? 12 : 13,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      theme: {
        background: termBg,
        foreground: "#e6edf3",
        cursor: "#e6edf3",
        selectionBackground: "#264f78"
      },
      allowProposedApi: true
    });
    const fit = new Fit();
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
    // Soft keyboard: keep the host in view when the PTY textarea focuses.
    term.textarea?.addEventListener("focus", () => {
      hostRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    return term;
  }

  async function attach(id: string): Promise<void> {
    disposeSocket();
    setStatus("connecting");
    let term: Terminal;
    try {
      term = await ensureTerm();
    } catch (err) {
      setStatus("error");
      errorToast(err instanceof Error ? err.message : "Failed to load terminal.");
      return;
    }
    const fit = fitRef.current;

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
      const boot = bootstrapRef.current?.trim();
      if (boot && bootstrappedRef.current !== id) {
        bootstrappedRef.current = id;
        // Let the login shell paint its prompt before injecting the command.
        window.setTimeout(() => {
          if (wsRef.current === ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "input", data: `${boot}\n` }));
          }
        }, 250);
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
          if (!cancelled) void attach(info.id);
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

    function refit(): void {
      const fit = fitRef.current;
      const term = termRef.current;
      const ws = wsRef.current;
      if (!fit || !term) return;
      fit.fit();
      const dims = fit.proposeDimensions();
      if (dims && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols: dims.cols, rows: dims.rows }));
      }
    }

    const ro = new ResizeObserver(() => refit());
    ro.observe(host);

    // iOS/Android soft keyboard changes visualViewport without always resizing the host.
    const vv = window.visualViewport;
    vv?.addEventListener("resize", refit);
    vv?.addEventListener("scroll", refit);

    return () => {
      ro.disconnect();
      vv?.removeEventListener("resize", refit);
      vv?.removeEventListener("scroll", refit);
    };
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
