import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { builtinAgentConfigBundle } from "../src/core/agents/config/templates.ts";
import { normalizeTool } from "../src/core/agents/config/normalize.ts";
import { cliSetupDone, toolSetupActions } from "../src/ui/features/settings/agents/tool-setup.ts";

describe("agent CLI setup metadata", () => {
  it("seeds install/login shells for Claude, Codex, and Cursor", () => {
    const bundle = builtinAgentConfigBundle();
    const byId = new Map(bundle.tools.map((tool) => [tool.id, tool]));
    expect(byId.get("claude")?.setup?.installShell).toMatch(/claude\.ai\/install\.sh/);
    expect(byId.get("claude")?.setup?.loginShell).toBe("claude auth login");
    expect(byId.get("codex")?.setup?.installShell).toMatch(/codex\/install\.sh/);
    expect(byId.get("codex")?.setup?.loginShell).toBe("codex login");
    expect(byId.get("cursor")?.setup?.installShell).toMatch(/cursor\.com\/install/);
    expect(byId.get("cursor")?.setup?.loginShell).toBe("cursor-agent login");
    expect(byId.get("cursor")?.command).toBe("cursor-agent");
    expect(byId.get("cursor")?.adapter).toBe("acp");
    expect(byId.get("grok")?.command).toBe("grok");
    expect(byId.get("grok")?.setup).toBeUndefined();
    expect(byId.get("opencode")?.setup).toBeUndefined();
    expect(byId.get("kiro")?.setup).toBeUndefined();
  });

  it("shows Install when missing and Login when present for tools with setup shells", () => {
    const claude = normalizeTool({
      id: "claude",
      command: "claude",
      adapter: "claude",
      setup: {
        installShell: "curl -fsSL https://claude.ai/install.sh | bash",
        loginShell: "claude auth login"
      }
    });
    const missing = toolSetupActions(claude, { available: false });
    expect(missing.showInstall).toBe(true);
    expect(missing.showLogin).toBe(false);
    expect(missing.showEnable).toBe(false);
    expect(missing.showRescan).toBe(true);

    const ready = toolSetupActions(claude, { available: true });
    expect(ready.showInstall).toBe(false);
    expect(ready.showLogin).toBe(true);
    expect(ready.showEnable).toBe(false);

    const disabled = normalizeTool({
      id: "claude",
      command: "claude",
      adapter: "claude",
      enabled: false,
      setup: {
        installShell: "curl -fsSL https://claude.ai/install.sh | bash",
        loginShell: "claude auth login"
      }
    });
    const enable = toolSetupActions(disabled, { available: true });
    expect(enable.showEnable).toBe(true);
    expect(enable.showInstall).toBe(false);
    expect(enable.showLogin).toBe(true);

    const grok = normalizeTool({ id: "grok", command: "agent", adapter: "grok" });
    const grokMissing = toolSetupActions(grok, { available: false });
    expect(grokMissing.showInstall).toBe(false);
    expect(grokMissing.showLogin).toBe(false);
    expect(grokMissing.showRescan).toBe(true);
  });

  it("marks first-run CLI setup done when any enabled tool is available", () => {
    const ready = normalizeTool({ id: "claude", command: "claude", adapter: "claude", enabled: true });
    const disabled = normalizeTool({
      id: "codex",
      command: "codex",
      adapter: "codex",
      enabled: false
    });
    const missing = normalizeTool({ id: "cursor", command: "cursor-agent", adapter: "acp", enabled: true });

    expect(cliSetupDone([ready], { claude: { available: true } })).toBe(true);
    expect(cliSetupDone([ready], { claude: { available: false } })).toBe(false);
    expect(cliSetupDone([disabled], { codex: { available: true } })).toBe(false);
    expect(
      cliSetupDone([disabled, missing], {
        codex: { available: true },
        cursor: { available: false }
      })
    ).toBe(false);
    expect(
      cliSetupDone([disabled, ready], {
        codex: { available: true },
        claude: { available: true }
      })
    ).toBe(true);
  });

  it("wires Settings UI to the setup modal and probe endpoint", () => {
    const section = readFileSync(
      path.join(process.cwd(), "src/ui/features/settings/agents/config-section.tsx"),
      "utf8"
    );
    const modal = readFileSync(
      path.join(process.cwd(), "src/ui/features/settings/agents/cli-setup-modal.tsx"),
      "utf8"
    );
    const pane = readFileSync(path.join(process.cwd(), "src/ui/shared/components/terminal-pane.tsx"), "utf8");
    expect(section).toContain("toolSetupActions");
    expect(section).toContain("AgentCliSetupModal");
    expect(section).toContain("/api/agent-config/probe");
    expect(section).toContain("Not installed");
    expect(section).toContain("Install");
    expect(section).toContain("Login");
    expect(section).toContain("Rescan");
    expect(modal).toContain('kind: "shell"');
    expect(modal).toContain("bootstrapCommand");
    expect(pane).toContain("bootstrapCommand");
  });

  it("wires home first-run checklist to CLI onboarding modal and probe", () => {
    const checklist = readFileSync(
      path.join(process.cwd(), "src/ui/features/home/setup-checklist.tsx"),
      "utf8"
    );
    const onboard = readFileSync(
      path.join(process.cwd(), "src/ui/features/home/cli-onboarding-modal.tsx"),
      "utf8"
    );
    const home = readFileSync(path.join(process.cwd(), "src/ui/features/home/page.tsx"), "utf8");
    expect(home).toContain("SetupChecklist");
    expect(checklist).toContain("cliSetupDone");
    expect(checklist).toContain("CliOnboardingModal");
    expect(checklist).toContain("/api/agent-config/probe");
    expect(checklist).toContain("Detect installed agent CLIs");
    expect(onboard).toContain("AgentCliSetupModal");
    expect(onboard).toContain("toolSetupActions");
    expect(onboard).toContain("Enable");
    expect(onboard).toContain("Install");
    expect(onboard).toContain("Rescan");
    expect(onboard).toContain("/api/agent-config/tools");
  });
});
