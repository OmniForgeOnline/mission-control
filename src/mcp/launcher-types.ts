export interface McpLaunch {
  command: string;
  args: string[];
}

export interface McpConfigArgs {
  /** Args to append to the agent command (the agent's CLI flags). */
  cliArgs: string[];
  /** Env vars to merge into the agent child env so the MCP server can find the harness root. */
  env: Record<string, string>;
  /** Absolute path to the JSON config file written for claude. Useful for diagnostics. */
  configPath?: string;
  /** Worktree-local extension config (e.g. .claude/settings.local.json). */
  extensionConfigPath?: string;
}
