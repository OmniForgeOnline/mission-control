import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SHUTDOWN_WARNING, requestShutdown } from "../src/ui/features/system/shutdown.ts";
import { ui } from "../src/ui/app/state.ts";
import type { AppState } from "../src/ui/app/types.ts";

const PAGE = path.join(process.cwd(), "src/ui/features/system/page.tsx");

describe("UI shutdown warning copy", () => {
  it("warns that all running processes are terminated", () => {
    expect(SHUTDOWN_WARNING.message).toContain("All running processes will be terminated");
  });

  it("warns the UI is unavailable until a terminal restart", () => {
    expect(SHUTDOWN_WARNING.message).toContain("unavailable until the app is restarted from the terminal");
  });

  it("uses danger styling and explicit labels", () => {
    expect(SHUTDOWN_WARNING.title).toContain("Shut down");
    expect(SHUTDOWN_WARNING.confirmLabel).toBe("Shut down");
    expect(SHUTDOWN_WARNING.cancelLabel).toBe("Cancel");
  });
});

describe("UI shutdown control is confirmation-gated", () => {
  const source = () => readFileSync(PAGE, "utf8");

  it("renders a danger shutdown control in the maintenance view", () => {
    const src = source();
    expect(src).toContain("Shut down Mission Control");
    expect(src).toContain('class="btn btn-danger"');
    expect(src).toContain("data-shutdown");
    expect(src).toContain("PowerControl");
  });

  it("opens the confirmation modal before any shutdown request", () => {
    const src = source();
    // The confirm() call (modal) must appear before requestShutdown().
    const confirmIndex = src.indexOf("confirm({");
    const requestIndex = src.indexOf("requestShutdown()");
    expect(confirmIndex).toBeGreaterThan(-1);
    expect(requestIndex).toBeGreaterThan(-1);
    expect(confirmIndex).toBeLessThan(requestIndex);
    // And the modal uses the required warning copy.
    expect(src).toContain("...SHUTDOWN_WARNING");
    expect(src).toContain('tone: "danger"');
  });

  it("does not request shutdown when the operator cancels", () => {
    const src = source();
    // The early return on !ok sits between confirm() and requestShutdown().
    const confirmIndex = src.indexOf("confirm({");
    const requestIndex = src.indexOf("requestShutdown()");
    const returnIndex = src.indexOf("if (!ok) return");
    expect(returnIndex).toBeGreaterThan(confirmIndex);
    expect(returnIndex).toBeLessThan(requestIndex);
  });

  it("guards against duplicate requests with a pending state", () => {
    expect(source()).toContain("withPending");
  });
});

describe("UI shutdown client", () => {
  // The token the same-origin UI receives via boot state (/api/state) and must
  // echo back. Mutating the singleton state is how the client reads it.
  const UI_TOKEN = "ui-shutdown-secret";

  afterEach(() => {
    vi.unstubAllGlobals();
    ui.data = null;
  });

  it("POSTs the shared /api/shutdown endpoint on confirm", async () => {
    ui.data = { shutdownToken: UI_TOKEN } as unknown as AppState;
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", (_url: string, init?: RequestInit) => {
      calls.push({ url: _url, init });
      return Promise.resolve(
        new Response(JSON.stringify({ shutting_down: true }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );
    });

    await requestShutdown();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/api/shutdown");
    expect(calls[0]?.init?.method).toBe("POST");
  });

  it("sends the boot-state shutdown token in a non-simple header", async () => {
    ui.data = { shutdownToken: UI_TOKEN } as unknown as AppState;
    const calls: Array<{ init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", (_url: string, init?: RequestInit) => {
      calls.push({ init });
      return Promise.resolve(
        new Response(JSON.stringify({ shutting_down: true }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );
    });

    await requestShutdown();

    // The custom header forces a CORS preflight, so a cross-site form POST
    // (which cannot set custom headers) is blocked by the browser. This is the
    // CSRF defense the token backs; the UI proves it by carrying the token.
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("x-shutdown-token")).toBe(UI_TOKEN);
  });

  it("surfaces a backend error instead of silently failing", async () => {
    ui.data = { shutdownToken: UI_TOKEN } as unknown as AppState;
    vi.stubGlobal(
      "fetch",
      () =>
        Promise.resolve(
          new Response(JSON.stringify({ error: "shutdown refused" }), {
            status: 500,
            headers: { "content-type": "application/json" }
          })
        )
    );

    await expect(requestShutdown()).rejects.toThrow("shutdown refused");
  });
});
