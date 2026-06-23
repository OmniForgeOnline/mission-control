import { readFile } from "node:fs/promises";
import path from "node:path";

describe("headless agent architecture", () => {
  it("does not depend on PTY/WebSocket terminal transport", async () => {
    const client = await readFile(path.join(process.cwd(), "src/ui", "main.ts"), "utf8");
    const server = await readFile(path.join(process.cwd(), "src", "server", "index.ts"), "utf8");
    const pkg = await readFile(path.join(process.cwd(), "package.json"), "utf8");

    expect(client).not.toContain("xterm");
    expect(client).not.toContain("WebSocket(");
    expect(client).not.toContain("/api/runs/${runId}/terminal");
    expect(server).not.toContain("attachTerminalWebSocketServer");
    expect(pkg).not.toContain("node-pty");
    expect(pkg).not.toContain("@xterm/xterm");
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
