import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const SHELL = process.env["SHELL"] || "/bin/zsh";
const IS_WINDOWS = process.platform === "win32";

const cachedLoginEnv = new Map<string, NodeJS.ProcessEnv>();

function parsePrintenv(output: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const line of output.split("\n")) {
    if (!line) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    env[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return env;
}

/**
 * Remove known noise from a PATH string. Uses {@link path.delimiter} so it works
 * on POSIX (`:`) and Windows (`;`) alike. Exported and delimiter-parametric so
 * the cleansing is unit-testable on any host platform.
 */
export function cleanPathString(value: string, delimiter: string = path.delimiter): string {
  const badPathFragments = [
    "Code/User/globalStorage",
    "copilot-chat",
    "github.copilot",
    "debugCommand"
  ];
  return value
    .split(delimiter)
    .filter((part) => part && !badPathFragments.some((bad) => part.includes(bad)))
    .join(delimiter);
}

/**
 * Strip VS Code / Cursor / Codespaces shell-integration variables that cause
 * OSC 633 banner sequences to be injected into child terminals. These banners
 * land on the TTY before our command and corrupt the line zsh tries to exec.
 */
function stripShellIntegration(env: NodeJS.ProcessEnv): void {
  const drop = [
    "VSCODE_SHELL_INTEGRATION",
    "VSCODE_INJECTION",
    "VSCODE_NONCE",
    "VSCODE_STABLE",
    "VSCODE_GIT_ASKPASS_NODE",
    "VSCODE_GIT_ASKPASS_EXTRA_ARGS",
    "VSCODE_GIT_ASKPASS_MAIN",
    "VSCODE_GIT_IPC_HANDLE",
    "VSCODE_IPC_HOOK_CLI",
    "TERM_PROGRAM_VERSION"
  ];
  for (const key of drop) {
    delete env[key];
  }
  if (env["TERM_PROGRAM"] === "vscode") {
    env["TERM_PROGRAM"] = "xterm";
  }
}

/**
 * Whether a POSIX login shell is available to capture env from. Windows has no
 * such concept (it returns false, so the resolver falls back to `process.env`
 * and `where`). Injectable so the platform decision is unit-testable.
 */
export function loginShellAvailable(opts?: {
  platform?: NodeJS.Platform;
  shell?: string;
  shellExists?: boolean;
}): boolean {
  const platform = opts?.platform ?? process.platform;
  if (platform === "win32") return false;
  const shell = opts?.shell ?? SHELL;
  if (!shell) return false;
  return opts?.shellExists ?? existsSync(shell);
}

function getLoginEnvironment(cwd: string = process.cwd()): NodeJS.ProcessEnv {
  if (!loginShellAvailable()) {
    // Windows, or no usable login shell: inherit the launching environment as-is.
    return { ...process.env };
  }
  const cacheKey = cwd;
  const cached = cachedLoginEnv.get(cacheKey);
  if (cached) return cached;

  try {
    // Capture the login-shell environment (PATH from .zprofile/.zshrc, mise/direnv, etc).
    //
    // IMPORTANT: use a LOGIN shell (-l) but NOT an interactive shell (-i).
    // An interactive shell enables job control, which calls tcsetpgrp() and
    // takes ownership of the controlling terminal's foreground process group.
    // When that subprocess exits, the terminal can be left pointing at a dead
    // process group, after which Ctrl+C (SIGINT) is delivered to the wrong
    // group and never reaches this Node process. A login shell alone sources
    // the same startup files without ever touching terminal control.
    const output = execFileSync(SHELL, ["-lc", "printenv"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
      cwd
    });
    const fullEnv = parsePrintenv(output);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...fullEnv,
    };

    if (fullEnv["PATH"]) {
      env["PATH"] = cleanPathString(fullEnv["PATH"]);
    }

    stripShellIntegration(env);

    cachedLoginEnv.set(cacheKey, env);
    return env;
  } catch {
    // Last resort fallback
    return { ...process.env };
  }
}

/**
 * Call this once at process startup (server or daemon).
 * It mutates process.env so that the current Node process (and all its children,
 * including PTYs) see the same PATH and environment variables you have in your
 * normal terminal. This is the main thing that makes "claude" and "codex" just work.
 */
export function ensureLoginShellEnvironment(cwd?: string): void {
  const login = getLoginEnvironment(cwd);
  for (const [key, value] of Object.entries(login)) {
    if (value !== undefined) {
      process.env[key] = value;
    }
  }
  // Extra safety: if we got a good PATH, make sure it's set
  if (login["PATH"]) {
    process.env["PATH"] = login["PATH"];
  }
  stripShellIntegration(process.env);
}

function binaryNotFoundError(binaryName: string, hint: string, original: string): Error {
  return new Error(
    `Failed to resolve '${binaryName}'.\n` +
      `${hint}\n\n` +
      `Make sure '${binaryName}' is installed and appears when you run ` +
      `'${IS_WINDOWS ? `where ${binaryName}` : `command -v ${binaryName}`}' in your terminal.\n` +
      `Original error: ${original}`
  );
}

export function resolveCommandBinary(binaryName: string, cwd: string = process.cwd()): string {
  if (IS_WINDOWS) {
    try {
      const output = execFileSync("where", [binaryName], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 4000,
        cwd
      }).trim();
      const first = output.split(/\r?\n/)[0];
      if (!first) {
        throw new Error(`'${binaryName}' not found in PATH`);
      }
      return first;
    } catch (err: unknown) {
      throw binaryNotFoundError(
        binaryName,
        `The harness resolves agent commands on Windows via 'where ${binaryName}'.`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  if (!loginShellAvailable()) {
    throw binaryNotFoundError(
      binaryName,
      `No login shell (${SHELL}) is available to resolve the command.`,
      `'${binaryName}' not found`
    );
  }

  try {
    // Resolve via a LOGIN shell (-l), not an interactive one (-i). See the note
    // in getLoginEnvironment: -i grabs the controlling terminal and breaks Ctrl+C.
    const output = execFileSync(SHELL, ["-lc", `command -v ${binaryName}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 4000,
      cwd
    }).trim();

    if (!output) {
      throw new Error(`'${binaryName}' not found in PATH`);
    }

    return output;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw binaryNotFoundError(
      binaryName,
      `The harness resolves agent commands by running them through your login shell (${SHELL} -lc).\n` +
        `This ensures it sees exactly the same PATH you have in your normal terminal.`,
      message
    );
  }
}
