import { cleanPathString, loginShellAvailable } from "../src/core/agents/resolver.ts";

describe("cleanPathString", () => {
  it("drops editor/Copilot noise fragments and keeps the rest, on the POSIX delimiter", () => {
    const cleaned = cleanPathString(
      "/usr/local/bin:/usr/bin:~/Code/User/globalStorage:~/copilot-chat:~/bin",
      ":"
    );
    expect(cleaned).toBe("/usr/local/bin:/usr/bin:~/bin");
  });

  it("is delimiter-agnostic so Windows PATH (`;`) is cleansed correctly", () => {
    const cleaned = cleanPathString(
      "C:\\tools\\bin;C:\\Windows\\System32;C:\\Users\\me\\github.copilot;C:\\bin",
      ";"
    );
    expect(cleaned).toBe("C:\\tools\\bin;C:\\Windows\\System32;C:\\bin");
  });

  it("preserves an already-clean PATH unchanged", () => {
    const cleaned = cleanPathString("/usr/local/bin:/usr/bin", ":");
    expect(cleaned).toBe("/usr/local/bin:/usr/bin");
  });
});

describe("loginShellAvailable", () => {
  it("is never available on Windows", () => {
    expect(loginShellAvailable({ platform: "win32", shell: "/bin/zsh", shellExists: true })).toBe(false);
  });

  it("is available on POSIX when the configured shell exists", () => {
    expect(loginShellAvailable({ platform: "darwin", shell: "/bin/zsh", shellExists: true })).toBe(true);
    expect(loginShellAvailable({ platform: "linux", shell: "/bin/bash", shellExists: true })).toBe(true);
  });

  it("falls back when the configured shell does not exist", () => {
    expect(loginShellAvailable({ platform: "linux", shell: "/bin/zsh", shellExists: false })).toBe(false);
  });

  it("is unavailable when no shell is configured", () => {
    expect(loginShellAvailable({ platform: "linux", shell: "", shellExists: true })).toBe(false);
  });
});
