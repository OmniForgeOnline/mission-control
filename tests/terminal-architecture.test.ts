import { readFile } from "node:fs/promises";
import path from "node:path";

describe("interactive terminal architecture", () => {
  it("uses xterm + node-pty + WebSocket for interactive agent TUIs", async () => {
    const client = await readFile(path.join(process.cwd(), "src/ui/shared/components/terminal-pane.tsx"), "utf8");
    const server = await readFile(path.join(process.cwd(), "src/server/index.ts"), "utf8");
    const pkg = await readFile(path.join(process.cwd(), "package.json"), "utf8");
    const ws = await readFile(path.join(process.cwd(), "src/terminal/ws-server.ts"), "utf8");

    expect(client).toContain("@xterm/xterm");
    expect(client).toContain("WebSocket");
    expect(server).toContain("attachTerminalWebSocketServer");
    expect(ws).toContain("/api/terminal/ws");
    expect(pkg).toContain("node-pty");
    expect(pkg).toContain("@xterm/xterm");
  });

  it("keeps headless runners free of PTY transport", async () => {
    const headless = await readFile(path.join(process.cwd(), "src/runners/headless.ts"), "utf8");
    expect(headless).not.toContain("node-pty");
    expect(headless).not.toContain("xterm");
    expect(headless).toContain("spawn");
  });

  it("captures a login (not interactive) shell environment for resolving agent commands", async () => {
    const resolver = await readFile(path.join(process.cwd(), "src", "core", "agents", "resolver.ts"), "utf8");

    // Must use a login shell to pick up PATH, but must NOT use an interactive
    // shell: -i enables job control which steals the controlling terminal and
    // breaks Ctrl+C/SIGINT delivery to this process.
    expect(resolver).toContain("\"-lc\"");
    expect(resolver).not.toContain("\"-ilc\"");
    expect(resolver).toContain("printenv");
  });
});
