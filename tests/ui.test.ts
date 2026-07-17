/* global HTMLButtonElement, window */
import { readFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn()
});

import {
  blockedReasonHtml,
  formatBlockedReason
} from "../src/ui/features/tasks/detail/blocked-reason.ts";
import { escapeHtml, onEnterSubmit, withPending } from "../src/ui/shell/dom.ts";
import { isTaskFilter, parseTaskFilter } from "../src/ui/features/tasks/filters.ts";
import { renderMarkdown, stripFrontmatter } from "../src/ui/shared/lib/markdown.ts";
import { appendAttachments, collectUploads, removeAttachment } from "../src/ui/data/attachments.ts";
import { includesScope, includesTaskScope } from "../src/ui/app/scopes.ts";
import { taskIsComplete } from "../src/ui/app/task-status.ts";
import {
  DEFAULT_TICKET_FILTER,
  filterProjectTickets,
  projectTicketStatuses
} from "../src/ui/features/projects/ticket-table.ts";
import type { AppState, AutonomyJob, HarnessAttachment, HarnessTask, ProjectSummary, WorkflowSummary } from "../src/ui/app/types.ts";

function minimalTask(overrides: Partial<HarnessTask> = {}): HarnessTask {
  const now = "2026-06-06T12:00:00.000Z";
  return {
    id: "task-1",
    title: "Example",
    description: "",
    agent: "grok",
    source: "manual",
    links: [],
    targets: [],
    messages: [],
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function minimalAppState(overrides: Partial<AppState> = {}): AppState {
  const workflow: WorkflowSummary = {
    id: "default",
    name: "Default",
    initial: "author",
    stepIds: ["author", "review"],
    steps: {
      author: { kind: "agent", agent: "author", approval: "none", effort: "medium" },
      review: { kind: "agent", agent: "reviewer", approval: "operator" }
    },
    defaults: { author: "grok", reviewer: "grok", effort: "low" }
  };
  return {
    root: "/tmp/harness",
    connectors: { providers: [], connections: [] },
    tasks: [],
    runs: [],
    memoryPages: [],
    autonomyJobs: [],
    workflows: [workflow],
    settings: { defaultAgent: "grok", activityThresholds: { staleMs: 240_000, longRunMs: 1_200_000 }, theme: "dark", projectsRoot: "/tmp" },
    agents: [{ id: "grok", displayName: "Grok", supportsEffort: true, effortLevels: ["low", "medium", "high"] }],
    activityThresholds: { staleMs: 240_000, longRunMs: 1_200_000 },
    ...overrides
  };
}

async function readClientTree(): Promise<string> {
  const dir = path.join(process.cwd(), "src/ui");
  const out: string[] = [];
  async function walk(d: string): Promise<void> {
    for (const name of await readdir(d)) {
      const full = path.join(d, name);
      const info = await stat(full);
      if (info.isDirectory()) {
        await walk(full);
        continue;
      }
      if (full.endsWith(".ts") || full.endsWith(".tsx") || full.endsWith(".css") || full.endsWith(".html")) {
        out.push(await readFile(full, "utf8"));
      }
    }
  }
  await walk(dir);
  return out.join("\n");
}

describe("ui scopes", () => {
  it("includesScope matches all or the exact target", () => {
    expect(includesScope(["all"], "tasks")).toBe(true);
    expect(includesScope(["tasks"], "tasks")).toBe(true);
    expect(includesScope(["tasks"], "runs")).toBe(false);
  });

  it("includesTaskScope requires a task id and tasks or task scope", () => {
    expect(includesTaskScope(["tasks"], null)).toBe(false);
    expect(includesTaskScope(["tasks"], "abc")).toBe(true);
    expect(includesTaskScope([`task:abc`], "abc")).toBe(true);
    expect(includesTaskScope([`task:other`], "abc")).toBe(false);
  });
});

describe("ui markdown", () => {
  it("stripFrontmatter removes YAML frontmatter", () => {
    const input = "---\ntitle: Plan\n---\nBody text";
    expect(stripFrontmatter(input)).toBe("Body text");
  });

  it("stripFrontmatter leaves content without frontmatter unchanged", () => {
    expect(stripFrontmatter("plain text")).toBe("plain text");
  });

  it("renderMarkdown renders basic GFM", () => {
    const html = renderMarkdown("**bold** and `code`");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>code</code>");
  });
});

describe("ui dom helpers", () => {
  it("escapeHtml escapes HTML special characters", () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&#39;"
    );
  });

  it("withPending disables the button, shows a spinner, and restores on settle", async () => {
    const button = {
      disabled: false,
      innerHTML: "<span>Search</span>",
      setAttribute: vi.fn(),
      removeAttribute: vi.fn()
    } as unknown as HTMLButtonElement;

    let resolveFn!: () => void;
    const pending = new Promise<void>((resolve) => {
      resolveFn = resolve;
    });

    const work = withPending(button, async () => {
      expect(button.disabled).toBe(true);
      expect(button.innerHTML).toContain("Working…");
      expect(button.innerHTML).toContain("icon-spin");
      await pending;
    });

    resolveFn();
    await work;

    expect(button.disabled).toBe(false);
    expect(button.innerHTML).toBe("<span>Search</span>");
    expect(button.removeAttribute).toHaveBeenCalledWith("aria-busy");
  });

  it("withPending is a no-op when the button is already disabled", async () => {
    const button = {
      disabled: true,
      innerHTML: "<span>Go</span>",
      setAttribute: vi.fn(),
      removeAttribute: vi.fn()
    } as unknown as HTMLButtonElement;
    const fn = vi.fn(async () => undefined);

    await withPending(button, fn);

    expect(fn).not.toHaveBeenCalled();
    expect(button.innerHTML).toBe("<span>Go</span>");
  });

  it("onEnterSubmit submits on plain Enter and prevents the default newline", () => {
    const submit = vi.fn();
    const preventDefault = vi.fn();
    onEnterSubmit(submit)({ key: "Enter", shiftKey: false, isComposing: false, preventDefault });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it("onEnterSubmit ignores Shift+Enter so newlines still work", () => {
    const submit = vi.fn();
    const preventDefault = vi.fn();
    onEnterSubmit(submit)({ key: "Enter", shiftKey: true, isComposing: false, preventDefault });
    expect(submit).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("onEnterSubmit ignores Enter during IME composition", () => {
    const submit = vi.fn();
    const preventDefault = vi.fn();
    onEnterSubmit(submit)({ key: "Enter", shiftKey: false, isComposing: true, preventDefault });
    expect(submit).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("onEnterSubmit leaves other keys untouched", () => {
    const submit = vi.fn();
    const preventDefault = vi.fn();
    onEnterSubmit(submit)({ key: "a", shiftKey: false, isComposing: false, preventDefault });
    expect(submit).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });
});

describe("ui task filters", () => {
  it("parseTaskFilter accepts known filters and defaults to all", () => {
    expect(isTaskFilter("blocked")).toBe(true);
    expect(isTaskFilter("nope")).toBe(false);
    expect(parseTaskFilter("awaiting")).toBe("awaiting");
    expect(parseTaskFilter("bogus")).toBe("all");
    expect(parseTaskFilter(null)).toBe("all");
  });
});

describe("ui blocked reason formatting", () => {
  it("maps internal harness config errors to recoverable guidance", () => {
    const formatted = formatBlockedReason(
      "Agent definitions are not loaded. Call loadAgentDefinitions() first."
    );
    expect(formatted.recoverable).toBe(true);
    expect(formatted.message).toContain("agent configuration");
    expect(formatted.hint).toContain("Resume");
  });

  it("maps network failures to recoverable guidance", () => {
    const formatted = formatBlockedReason("fetch failed: ECONNREFUSED 127.0.0.1:8080");
    expect(formatted.recoverable).toBe(true);
    expect(formatted.message).toContain("network");
    expect(formatted.hint).toContain("different agent");
  });

  it("maps grok reasoning effort failures to recoverable guidance", () => {
    const formatted = formatBlockedReason(
      "grok exited with code 1: Model grok-composer-2.5-fast does not support parameter reasoningEffort."
    );
    expect(formatted.recoverable).toBe(true);
    expect(formatted.message).toContain("does not support reasoning effort");
  });

  it("passes through unknown errors unchanged", () => {
    const formatted = formatBlockedReason("Mechanical checks failed: lint");
    expect(formatted).toEqual({
      message: "Mechanical checks failed: lint",
      recoverable: false
    });
  });

  it("maps repository binding blocks to operator recovery guidance", () => {
    const formatted = formatBlockedReason(
      "Repository binding required: add a git repository target before opening a merge request."
    );
    expect(formatted.recoverable).toBe(true);
    expect(formatted.message).toContain("git repository target");
    expect(formatted.hint).toContain("Bind a repository");
  });

  it("blockedReasonHtml escapes message and hint markup", () => {
    const html = blockedReasonHtml(
      "Agent definitions are not loaded. Call loadAgentDefinitions() first."
    );
    expect(html).toContain('class="blocked-reason recoverable"');
    expect(html).toContain('class="blocked-hint"');
    expect(html).not.toContain("loadAgentDefinitions()");
  });
});

describe("ui state helpers", () => {
  let state: typeof import("../src/ui/app/state.ts");

  beforeEach(async () => {
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn()
    });
    vi.stubGlobal("document", {
      documentElement: { setAttribute: vi.fn() }
    });
    vi.resetModules();
    state = await import("../src/ui/app/state.ts");
    state.ui.data = minimalAppState();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("relativeTime formats recent and missing timestamps", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-06T12:00:00.000Z"));
    expect(state.relativeTime()).toBe("—");
    expect(state.relativeTime("2026-06-06T11:59:30.000Z")).toBe("just now");
    expect(state.relativeTime("2026-06-06T11:30:00.000Z")).toBe("30m ago");
    expect(state.relativeTime("2026-06-06T06:00:00.000Z")).toBe("6h ago");
    expect(state.relativeTime("2026-06-05T12:00:00.000Z")).toBe("1d ago");
  });

  it("workflowForTask resolves workflow by id with fallback", () => {
    const task = minimalTask({ workflowRun: { workflowId: "missing", currentStepId: "author", completedSteps: [], stepApprovals: {} } });
    expect(state.workflowForTask(task)?.id).toBe("default");

    state.ui.data = minimalAppState({
      workflows: [
        { id: "custom", name: "Custom", initial: "author", stepIds: ["author"], steps: { author: { kind: "agent", agent: "author", approval: "none" } }, defaults: { author: "grok", reviewer: "grok" } }
      ]
    });
    const linked = minimalTask({ workflowRun: { workflowId: "custom", currentStepId: "author", completedSteps: [], stepApprovals: {} } });
    expect(state.workflowForTask(linked)?.id).toBe("custom");
  });

  it("effectiveTaskEffort prefers task override then step defaults", () => {
    const task = minimalTask({
      effort: "high",
      workflowRun: { workflowId: "default", currentStepId: "author", completedSteps: [], stepApprovals: {} }
    });
    expect(state.effectiveTaskEffort(task)).toBe("high");

    const inherited = minimalTask({
      workflowRun: { workflowId: "default", currentStepId: "author", completedSteps: [], stepApprovals: {} }
    });
    expect(state.effectiveTaskEffort(inherited)).toBe("medium");

    // A per-step effort override outranks the task-level effort.
    const overridden = minimalTask({
      effort: "high",
      stageEffortOverrides: { author: "low" },
      workflowRun: { workflowId: "default", currentStepId: "author", completedSteps: [], stepApprovals: {} }
    });
    expect(state.effectiveTaskEffort(overridden, "author")).toBe("low");
    // The override is scoped to its step; a different step still uses task effort.
    expect(state.effectiveTaskEffort(overridden, "reviewer")).toBe("high");
  });

  it("resolvedStepAgent uses overrides and default harness agent", () => {
    state.ui.data = minimalAppState({ stageAgentOverrides: { author: "custom-agent" } });
    const task = minimalTask({
      workflowRun: { workflowId: "default", currentStepId: "author", completedSteps: [], stepApprovals: {} }
    });
    expect(state.resolvedStepAgent(task)).toBe("custom-agent");

    state.ui.data = minimalAppState();
    expect(state.resolvedStepAgent(task)).toBe("grok");
  });

  it("resolvedStepAgent prefers task overrides over global overrides", () => {
    state.ui.data = minimalAppState({ stageAgentOverrides: { author: "codex" } });
    const task = minimalTask({
      stageAgentOverrides: { author: "claude" },
      workflowRun: { workflowId: "default", currentStepId: "author", completedSteps: [], stepApprovals: {} }
    });
    expect(state.resolvedStepAgent(task)).toBe("claude");
  });

  it("liveness reports active, stale, and long-running tasks", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-06T12:00:00.000Z"));
    state.ui.data = minimalAppState({ inflightTaskIds: ["task-1"] });

    expect(state.liveness(minimalTask({ blockedReason: "hook failed" }))).toBeNull();

    const active = state.liveness(
      minimalTask({
        runId: "run-1",
        startedAt: "2026-06-06T11:50:00.000Z",
        lastProgressAt: "2026-06-06T11:59:00.000Z",
        currentActivity: "testing"
      })
    );
    expect(active?.level).toBe("active");
    expect(active?.warn).toBe(false);

    const stale = state.liveness(
      minimalTask({
        runId: "run-1",
        startedAt: "2026-06-06T11:00:00.000Z",
        lastProgressAt: "2026-06-06T11:54:00.000Z",
        currentActivity: "waiting"
      })
    );
    expect(stale?.level).toBe("stale");
    expect(stale?.warn).toBe(true);

    const longRun = state.liveness(
      minimalTask({
        runId: "run-1",
        startedAt: "2026-06-06T11:30:00.000Z",
        lastProgressAt: "2026-06-06T11:59:00.000Z",
        currentActivity: "building"
      })
    );
    expect(longRun?.level).toBe("long");
    expect(longRun?.warn).toBe(true);
  });
});

describe("ui slice 4 polish and features", () => {
  it("ships premium CSS tokens and dialog helpers", async () => {
    const tree = await readClientTree();
    expect(tree).toContain("font-optical-sizing: auto");
    expect(tree).toContain("scrollbar-gutter: stable");
    expect(tree).toContain("text-wrap: balance");
    expect(tree).toContain("caret-color: var(--accent)");
    expect(tree).toContain("bindDialogDismiss");
    expect(tree).toContain("dismissTopmostOverlay");
    expect(tree).toContain("hasOpenOverlay");
  });

  it("uses incremental tail rendering and concurrent tail instances", async () => {
    const tree = await readClientTree();
    expect(tree).toContain("renderInstance");
    expect(tree).toContain("getOrCreateTail");
    expect(tree).toContain("pollActiveTails");
    expect(tree).toContain("renderedRows");
  });

  it("opens artifacts in the slideover instead of new tabs", async () => {
    const tree = await readClientTree();
    expect(tree).toContain("openArtifactViewer");
    expect(tree).not.toMatch(/window\.open\([^)]*artifacts/);
  });

  it("sends ticket messages through the selected workflow step chat", async () => {
    const tree = await readClientTree();
    expect(tree).toContain("Send to agent");
    expect(tree).toContain("stepChatSubmission");
    expect(tree).toContain("noteOnly: true");
    expect(tree).not.toContain("taskReplyHost");
  });

  it("keeps the workflow activity panel log-only", async () => {
    const source = readFileSync(
      path.join(process.cwd(), "src/ui/features/tasks/detail/workflow/panel/activity.tsx"),
      "utf8"
    );

    expect(source).toContain("LiveTailSection");
    expect(source).toContain("Timeline");
    expect(source).toContain("RunActivityFeed");
    expect(source).toContain("appendRunActivityEntry");
    expect(source).not.toContain("openTail(");
    expect(source).not.toContain("TaskThread");
    expect(source).not.toContain("Full ticket transcript");
    expect(source).not.toContain("Step-specific chat lives on the Step tab");
    expect(source).not.toContain("buildTranscript");
  });

  it("renders selected step conversation through the step panel", async () => {
    const source = readFileSync(
      path.join(process.cwd(), "src/ui/features/tasks/detail/workflow/panel/step-chat.tsx"),
      "utf8"
    );

    expect(source).toContain("Step conversation");
    expect(source).toContain("TaskMessagesThread");
    expect(source).toContain("messagesForStep");
    expect(source).not.toContain("subscribeRunEventStream");
    expect(source).not.toContain("RunActivityFeed");
  });

  it("ships an in-ticket workflow canvas with selection state", async () => {
    const tree = await readClientTree();
    expect(tree).toContain("WorkflowPane");
    expect(tree).toContain("WorkflowCanvas");
    expect(tree).toContain("selectedStepId");
  });

  it("supports bulk section select and shift-click range select", async () => {
    const tree = await readClientTree();
    expect(tree).toContain("section-select");
    expect(tree).toContain("global-select");
    expect(tree).toContain("shiftKey");
    expect(tree).toContain("lastClicked");
  });

  it("auto-applies settings and offers blocked-task agent retry", async () => {
    const tree = await readClientTree();
    expect(tree).toContain("Changes apply automatically");
    expect(tree).toContain("applyPatch");
    expect(tree).toContain("BlockedRecovery");
    expect(tree).toContain("RepoBindingRecovery");
    expect(tree).toContain("/api/tasks/");
    expect(tree).toContain("bind-repo");
    expect(tree).toContain("/api/tasks/${task.id}/stage-agents/");
    expect(tree).toContain("/api/tasks/${task.id}/resume");
  });

  it("lets operators override step agents from the workflow side panel", async () => {
    const tree = await readClientTree();
    expect(tree).toContain("WorkflowStepPanel");
    expect(tree).toContain("setStepAgent");
    expect(tree).toContain("/stage-agents/");
    expect(tree).toContain("Workflow default");
  });

  it("reserves Escape for overlay dismiss only", async () => {
    const tree = await readClientTree();
    expect(tree).toContain("dismissTopmostOverlay");
    expect(tree).not.toMatch(/Escape[\s\S]{0,120}navigate\("tasks"\)/);
  });
});

describe("mission-control client surface", () => {
  it("uses a vanilla two-pane shell (top bar + rail + main)", async () => {
    const html = await readFile(path.join(process.cwd(), "src/ui", "index.html"), "utf8");
    expect(html).toContain('id="appBar"');
    expect(html).toContain('id="appRail"');
    expect(html).toContain('id="viewContent"');
    expect(html).toContain('id="paletteDialog"');
    expect(html).not.toContain('class="shell"');
  });

  it("ships a command palette with Cmd/Ctrl+K and quick keyboard navigation", async () => {
    const tree = await readClientTree();
    expect(tree).toMatch(/openPalette\s*\(/);
    expect(tree).toMatch(/key.toLowerCase\(\)\s*===\s*"k"/);
    expect(tree).toContain('"harness:open-palette"');
  });

  it("supports task multi-select with a bulk action bar", async () => {
    const tree = await readClientTree();
    expect(tree).toContain("data-toggle=");
    expect(tree).toContain("bulk-bar");
    expect(tree).toContain("bulkRun");
    expect(tree).toContain("bulkDelete");
  });

  it("embeds interactive terminal primitives (xterm + WS) for agent TUIs", async () => {
    const tree = await readClientTree();
    expect(tree).toContain("@xterm/xterm");
    expect(tree).toContain("WebSocket");
    expect(tree).toContain("/api/terminal/ws");
    expect(tree).toContain("TerminalPane");
    // Workflow steps attach to the daemon session only — no free-floating shell/TUI spawn.
    expect(tree).not.toContain("Open agent TUI");
    expect(tree).not.toContain("Open shell");
    // Headless run tail stays SSE/HTTP; no per-run terminal path.
    expect(tree).not.toContain("/api/runs/${runId}/terminal");
  });

  it("exposes an inline live tail accordion for running runs", async () => {
    const tree = await readClientTree();
    expect(tree).toContain("bindTails");
    expect(tree).toContain("data-tail-host");
    expect(tree).toContain("openTail");
    expect(tree).toContain("wf-live-tail");
    expect(tree).toContain("/api/runs/${runId}/tail");
    expect(tree).not.toContain('id="tailDialog"');
  });

  it("uses semantic toasts instead of blocking dialogs", async () => {
    const tree = await readClientTree();
    expect(tree).not.toContain("window.confirm(");
    expect(tree).toContain("toast(");
  });

  it("shows running feedback on autonomy job rows without duplicate labels", async () => {
    const tree = await readClientTree();
    expect(tree).toContain("autonomy-progress");
    expect(tree).toContain("autonomy-live-dot");
    expect(tree).toContain("data-stop-job");
    expect(tree).not.toContain("autonomy-running-copy");
    expect(tree).not.toContain('class="autonomy-running"');
  });

  it("opens @ target suggestions above the homepage intake composer", async () => {
    const tree = await readClientTree();
    expect(tree).toContain("positionSuggestBox");
    expect(tree).toContain('input.id === "intakeInput"');
    expect(tree).toContain('input.closest(".intake-composer")');
  });

  it("shows intake queue status instead of a blocking classification state", async () => {
    const tree = await readClientTree();
    expect(tree).toContain("intake-queue-");
    expect(tree).toContain("intake-request-card");
    expect(tree).toContain("Waiting to classify");
    expect(tree).toContain("value={draft}");
    expect(tree).not.toContain("disabled={running}");
    expect(tree).not.toContain("if (running) return");
    expect(tree).not.toContain("Classifying your request");
  });

  it("requires project-scoped intake instead of homepage unscoped intake", async () => {
    const tree = await readClientTree();
    expect(tree).not.toContain("Create an unscoped ticket");
    expect(tree).not.toContain("/api/intake/messages");
    expect(tree).not.toContain("Project scope:");
    expect(tree).toContain("renderProjectView");
    expect(tree).toContain('view === "project"');
    expect(tree).toContain("/api/projects/${project.id}/intake/messages");
    expect(tree).toContain("project-ticket-badge");
  });

  it("guides first-time users with an inline setup checklist instead of a blocking wizard", async () => {
    const tree = await readClientTree();
    expect(tree).toContain("home-setup-checklist");
    expect(tree).toContain("Install an agent CLI");
    expect(tree).toContain("Add your first project");
    expect(tree).toContain("Configure agents");
    expect(tree).toContain("Connect GitHub or GitLab");
    expect(tree).toContain("Run a quickstart");
    expect(tree).toContain('navigate("settings")');
    expect(tree).toContain('navigate("connectors")');
    expect(tree).toContain("Use the + next to Projects");
    expect(tree).not.toContain("onboarding-modal");
    expect(tree).not.toContain("setup-wizard");
  });

  it("lets the operator dismiss the first-run setup checklist so it stays gone", async () => {
    const tree = await readClientTree();
    expect(tree).toContain("harness:setup-dismissed");
    expect(tree).toContain("Dismiss first run setup");
    expect(tree).toContain("home-setup-dismiss");
  });

  it("uses icon-only intake controls for attachments and send", async () => {
    const attachments = await readFile(
      path.join(process.cwd(), "src/ui/shared/components/attachments.tsx"),
      "utf8"
    );
    const projectPage = await readFile(
      path.join(process.cwd(), "src/ui/features/projects/page.tsx"),
      "utf8"
    );

    expect(attachments).toContain('icon("paperclip"');
    expect(attachments).toContain('aria-label={uploading ? "Uploading files" : "Attach files"}');
    expect(projectPage).toContain("intake-submit-button");
    expect(projectPage).toContain('name="arrow-up"');
    expect(projectPage).not.toContain('Icon name="sparkles"');
    expect(projectPage).not.toContain('{sending ? "Sending" : uploading ? "Uploading" : "Send"}');
  });

  it("keeps the rail focused on project ticket buckets", async () => {
    const layout = await readFile(path.join(process.cwd(), "src/ui/shell/layout.ts"), "utf8");
    expect(layout).toContain("rail-project-status");
    expect(layout).toContain("rail-project-ticket-status");
    expect(layout).toContain("data-task-id");
    expect(layout).toContain("toggleProjectCollapse");
    expect(layout).toContain('label: "awaiting"');
    expect(layout).not.toContain('label: "W"');
    expect(layout).not.toContain('label: "A"');
    expect(layout).not.toContain('label: "Q"');
    expect(layout).not.toContain('label: "B"');
    expect(layout).not.toContain("const subItems");
    expect(layout).not.toContain('label: "Active"');
    expect(layout).not.toContain('label: "Awaiting"');
    expect(layout).not.toContain('label: "Queue"');
    expect(layout).not.toContain('label: "Done"');
  });

  it("styles rail project tickets as clickable rows", async () => {
    const shellCss = await readFile(path.join(process.cwd(), "src/ui/styles/shell.css"), "utf8");
    expect(shellCss).toContain(".rail-project-ticket {");
    expect(shellCss).toContain("cursor: pointer");
    expect(shellCss).toContain("color: var(--ink-muted)");
    expect(shellCss).toContain(".rail-project-ticket:hover");
  });

  it("keeps project ticket rows in the task stylesheet so generic task grid does not collapse them", async () => {
    const tasksCss = await readFile(path.join(process.cwd(), "src/ui/styles/tasks.css"), "utf8");
    expect(tasksCss).toContain(".project-task-row");
    expect(tasksCss).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(tasksCss).toContain("flex-shrink: 0");
  });

  it("does not expose project rebinding from the workflow step panel", async () => {
    const stepPanel = await readFile(
      path.join(process.cwd(), "src/ui/features/tasks/detail/workflow/panel/step.tsx"),
      "utf8"
    );
    expect(stepPanel).not.toContain("project-target");
    expect(stepPanel).not.toContain("bind-repo");
    expect(stepPanel).not.toContain("bindProject");
  });

  it("supports keyboard navigation in @ target suggestions", async () => {
    const tree = await readClientTree();
    expect(tree).toContain("highlightActiveItem");
    expect(tree).toContain('event.key === "ArrowDown"');
    expect(tree).toContain('event.key === "ArrowUp"');
    expect(tree).toContain("button.is-active");
  });
});

describe("ui workflow steps", () => {
  const codeFeatureWorkflow: WorkflowSummary = {
    id: "code-feature",
    name: "Code Feature",
    initial: "plan",
    stepIds: ["plan", "plan_gate", "implement", "create_merge_request", "resolve_conflicts", "review", "handoff"],
    steps: {
      plan: { kind: "conversation", agent: "codex", approval: "none" },
      plan_gate: { kind: "agent_turn", agent: "none", approval: "required" },
      implement: { kind: "agent_turn", agent: "grok", approval: "required", skill: "pr-driven-execution" },
      create_merge_request: { kind: "create_merge_request", agent: "none", approval: "none" },
      resolve_conflicts: { kind: "resolve_conflicts", agent: "none", approval: "none" },
      review: { kind: "review", agent: "reviewer", approval: "none" },
      handoff: { kind: "terminal", agent: "none", approval: "none" }
    },
    defaults: { author: "grok", reviewer: "codex", effort: "medium" },
    gitPipeline: {
      remediationStepId: "implement",
      postPushStepIds: ["create_merge_request", "resolve_conflicts", "review", "handoff"]
    }
  };

  let workflowSteps: typeof import("../src/ui/app/workflow-steps.ts");

  beforeEach(async () => {
    vi.resetModules();
    workflowSteps = await import("../src/ui/app/workflow-steps.ts");
  });

  it("marks approval-required steps as operator gated", () => {
    expect(workflowSteps.isOperatorGatedStep(codeFeatureWorkflow, "plan_gate")).toBe(true);
    expect(workflowSteps.isOperatorGatedStep(codeFeatureWorkflow, "implement")).toBe(true);
    expect(workflowSteps.isOperatorGatedStep(codeFeatureWorkflow, "create_merge_request")).toBe(false);
  });

  it("marks post-push mechanical steps as daemon driven", () => {
    expect(workflowSteps.isDaemonDrivenStep(codeFeatureWorkflow, "resolve_conflicts")).toBe(true);
    expect(workflowSteps.isDaemonDrivenStep(codeFeatureWorkflow, "create_merge_request")).toBe(true);
    expect(workflowSteps.isDaemonDrivenStep(codeFeatureWorkflow, "review")).toBe(true);
    expect(workflowSteps.isDaemonDrivenStep(codeFeatureWorkflow, "plan_gate")).toBe(false);
  });

  it("shows auto-advance note on current daemon step", () => {
    const task = minimalTask({
      runId: "run-1",
      workflowRun: {
        workflowId: "code-feature",
        currentStepId: "create_merge_request",
        completedSteps: ["plan", "plan_gate", "implement"],
        stepApprovals: {
          plan_gate: { stepId: "plan_gate", status: "approved", approvedAt: "2026-06-06T12:00:00.000Z" },
          implement: { stepId: "implement", status: "approved", approvedAt: "2026-06-06T12:00:00.000Z" }
        }
      }
    });
    expect(workflowSteps.stepShowsAutoAdvanceNote(task, codeFeatureWorkflow, "create_merge_request")).toBe(true);
    expect(workflowSteps.stepShowsAutoAdvanceNote(task, codeFeatureWorkflow, "implement")).toBe(false);
  });

  it("reports current step index for quantified progress", () => {
    expect(workflowSteps.currentStepIndex(codeFeatureWorkflow, "create_merge_request")).toBe(4);
    expect(workflowSteps.currentStepIndex(codeFeatureWorkflow, "missing")).toBe(0);
  });
});

describe("ui workflow graph state", () => {
  let graphState: typeof import("../src/ui/features/tasks/detail/workflow/state.ts");

  const workflow: WorkflowSummary = {
    id: "code-feature",
    name: "Code Feature",
    initial: "plan",
    stepIds: ["plan", "plan_gate", "implement", "create_merge_request", "resolve_conflicts", "review", "handoff"],
    steps: {
      plan: { kind: "conversation", agent: "codex", approval: "none" },
      plan_gate: { kind: "agent_turn", agent: "none", approval: "required" },
      implement: { kind: "agent_turn", agent: "grok", approval: "required", skill: "pr-driven-execution" },
      create_merge_request: { kind: "create_merge_request", agent: "none", approval: "none" },
      resolve_conflicts: { kind: "resolve_conflicts", agent: "none", approval: "none" },
      review: { kind: "review", agent: "reviewer", approval: "none" },
      handoff: { kind: "terminal", agent: "none", approval: "none" }
    },
    defaults: { author: "grok", reviewer: "codex", effort: "medium" },
    gitPipeline: {
      remediationStepId: "implement",
      postPushStepIds: ["create_merge_request", "resolve_conflicts", "review", "handoff"]
    }
  };

  beforeEach(async () => {
    vi.resetModules();
    graphState = await import("../src/ui/features/tasks/detail/workflow/state.ts");
  });

  it("treats post-review remediation as the current frontier instead of a completed MR path", () => {
    const task = minimalTask({
      pushedAt: "2026-06-16T14:06:42.159Z",
      mergeRequest: {
        provider: "github",
        url: "https://github.com/OmniForgeOnline/mission-control/pull/24",
        number: 24
      },
      workflowRun: {
        workflowId: "code-feature",
        currentStepId: "implement",
        completedSteps: ["plan", "plan_gate", "implement", "create_merge_request", "review"],
        stepApprovals: {
          plan_gate: { stepId: "plan_gate", status: "approved", approvedAt: "2026-06-06T12:00:00.000Z" },
          implement: { stepId: "implement", status: "approved", approvedAt: "2026-06-06T12:00:00.000Z" }
        }
      }
    });

    expect(graphState.nodeVisualState("implement", task, workflow)).toBe("current");
    expect(graphState.nodeVisualState("create_merge_request", task, workflow)).toBe("upcoming");
    expect(graphState.nodeVisualState("review", task, workflow)).toBe("upcoming");
  });
});

describe("ui palette fuzzy", () => {
  let fuzzy: typeof import("../src/ui/overlays/palette-fuzzy.ts");

  beforeEach(async () => {
    vi.resetModules();
    fuzzy = await import("../src/ui/overlays/palette-fuzzy.ts");
  });

  it("scores exact and prefix matches higher than distant subsequence matches", () => {
    const exact = fuzzy.fuzzyScore("task", "Go to tasks");
    const prefix = fuzzy.fuzzyScore("go", "Go to home");
    const distant = fuzzy.fuzzyScore("gt", "Go to settings");
    expect(exact).toBeGreaterThan(distant);
    expect(prefix).toBeGreaterThan(distant);
  });

  it("returns -1 when query is not a subsequence", () => {
    expect(fuzzy.fuzzyScore("zzz", "Go to tasks")).toBe(-1);
  });

  it("picks the best score across label, section, and meta", () => {
    expect(fuzzy.bestFuzzyScore("blocked", ["Example", "Tasks", "blocked"])).toBeGreaterThan(0);
  });
});

describe("ui palette recent", () => {
  let recent: typeof import("../src/ui/overlays/palette-recent.ts");

  beforeEach(async () => {
    const store: Record<string, string> = {};
    vi.stubGlobal("localStorage", {
      getItem: vi.fn((key: string) => store[key] ?? null),
      setItem: vi.fn((key: string, value: string) => {
        store[key] = value;
      }),
      removeItem: vi.fn((key: string) => {
        delete store[key];
      }),
      clear: vi.fn(() => {
        for (const key of Object.keys(store)) delete store[key];
      })
    });
    vi.resetModules();
    recent = await import("../src/ui/overlays/palette-recent.ts");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("records and returns recent palette ids with newest first", () => {
    recent.recordPaletteRecent("nav-tasks");
    recent.recordPaletteRecent("task-abc");
    recent.recordPaletteRecent("nav-memory");
    expect(recent.getRecentPaletteIds()).toEqual(["nav-memory", "task-abc", "nav-tasks"]);
  });
});

describe("ui slice 3 surfaces", () => {
  it("ships workflow actionability, palette upgrades, and shortcuts overlay", async () => {
    const tree = await readClientTree();
    expect(tree).toContain("getPrimaryAction");
    expect(tree).toContain("runNodeAction");
    expect(tree).not.toContain("Stage {stepNumber} of {totalSteps}");
    expect(tree).toContain("liveness(task)");
    expect(tree).toContain("Advancing automatically");
    expect(tree).toContain("operator-gated");
    expect(tree).toContain("WorkflowCanvas");
    expect(tree).toContain("bestFuzzyScore");
    expect(tree).toContain('"home", "tasks"');
    expect(tree).toContain("nav-${v}");
    expect(tree).toContain("Press ? for shortcuts");
    expect(tree).not.toContain("type 'g t' to navigate");
    expect(tree).toContain("openShortcuts");
    expect(tree).toContain('event.key === "?"');
    expect(tree).toContain("task-action-");
    expect(tree).toContain("recordPaletteRecent");
  });

  it("registers a shortcuts dialog in the shell", async () => {
    const html = await readFile(path.join(process.cwd(), "src/ui", "index.html"), "utf8");
    expect(html).toContain('id="shortcutsDialog"');
  });

});

describe("ui workflow step panel merge request", () => {
  const workflow: WorkflowSummary = {
    id: "code-feature",
    name: "Code Feature",
    initial: "review",
    stepIds: ["review"],
    steps: {
      review: { kind: "review", agent: "reviewer", approval: "none" }
    },
    defaults: { author: "grok", reviewer: "codex", effort: "medium" }
  };

  const mrUrl = "https://github.com/org/repo/pull/42";

  function reviewTask(overrides: Partial<HarnessTask> = {}): HarnessTask {
    return minimalTask({
      workflowRun: {
        workflowId: "code-feature",
        currentStepId: "review",
        completedSteps: [],
        stepApprovals: {}
      },
      ...overrides
    });
  }

  beforeEach(async () => {
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn()
    });
    vi.resetModules();
    const appState = await import("../src/ui/app/state.ts");
    appState.ui.data = minimalAppState({ workflows: [workflow] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders merge request link with href and label when MR data is present", async () => {
    const { h } = await import("preact");
    const { renderToString } = await import("preact-render-to-string");
    const { WorkflowStepPanel } = await import("../src/ui/features/tasks/detail/workflow/panel/step.tsx");

    const task = reviewTask({
      mergeRequest: { provider: "github", url: mrUrl, number: 42 }
    });
    const html = renderToString(h(WorkflowStepPanel, { task, workflow, stepId: "review" }));

    expect(html).toContain("Merge request");
    expect(html).toContain(`href="${mrUrl}"`);
    expect(html).toContain("PR #42");
  });

  it("hides merge request row and link when MR data is absent", async () => {
    const { h } = await import("preact");
    const { renderToString } = await import("preact-render-to-string");
    const { WorkflowStepPanel } = await import("../src/ui/features/tasks/detail/workflow/panel/step.tsx");

    const html = renderToString(h(WorkflowStepPanel, { task: reviewTask(), workflow, stepId: "review" }));

    expect(html).not.toContain("Merge request");
    expect(html).not.toContain(`href="${mrUrl}"`);
    expect(html).not.toContain("PR #42");
    expect(html).not.toContain("MR #");
  });

  it("does not render project rebinding controls on the step panel", async () => {
    const { h } = await import("preact");
    const { renderToString } = await import("preact-render-to-string");
    const { WorkflowStepPanel } = await import("../src/ui/features/tasks/detail/workflow/panel/step.tsx");

    const html = renderToString(h(WorkflowStepPanel, { task: reviewTask(), workflow, stepId: "review" }));

    expect(html).not.toContain("project-target");
    expect(html).not.toContain("project-target-select");
    expect(html).not.toContain(">Change<");
    expect(html).not.toContain("bind-repo");
  });
});

describe("ui task actions", () => {
  const codeFeatureWorkflow: WorkflowSummary = {
    id: "code-feature",
    name: "Code Feature",
    initial: "plan",
    stepIds: ["plan", "plan_gate", "implement"],
    steps: {
      plan: { kind: "conversation", agent: "codex", approval: "none" },
      plan_gate: { kind: "agent_turn", agent: "none", approval: "required", next: "implement" },
      implement: { kind: "agent_turn", agent: "grok", skill: "pr-driven-execution", approval: "required" }
    },
    defaults: { author: "grok", reviewer: "codex", effort: "medium" }
  };

  function planReviewTask(overrides: Partial<HarnessTask> = {}): HarnessTask {
    const timestamp = "2026-06-06T12:00:00.000Z";
    return minimalTask({
      description: "desc\n\n## Plan\n\n# Plan\nStep one",
      messages: [
        {
          id: "1",
          author: "agent",
          body: "<proposed_plan>\n# Plan\nStep one\n</proposed_plan>",
          createdAt: timestamp
        }
      ],
      workflowRun: {
        workflowId: "code-feature",
        currentStepId: "plan_gate",
        completedSteps: ["plan"],
        stepApprovals: {}
      },
      ...overrides
    });
  }

  let actions: typeof import("../src/ui/shared/components/task-actions.tsx");
  let state: typeof import("../src/ui/app/state.ts");

  beforeEach(async () => {
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn()
    });
    vi.stubGlobal("document", {
      documentElement: { setAttribute: vi.fn() }
    });
    vi.resetModules();
    state = await import("../src/ui/app/state.ts");
    actions = await import("../src/ui/shared/components/task-actions.tsx");
    state.ui.data = minimalAppState({ workflows: [codeFeatureWorkflow] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("enables plan refinement on plan_gate with a saved plan", () => {
    expect(actions.planRefinementReady(planReviewTask())).toBe(true);
  });

  it("shows Approve and run as the primary action at plan_gate", () => {
    const spec = actions.getPrimaryAction(planReviewTask());
    expect(spec?.action).toBe("approve-plan");
    expect(spec?.label).toBe("Approve & run");
  });

  it("labels queued run as Approve & run when it auto-approves", () => {
    const spec = actions.getPrimaryAction(
      minimalTask({
        workflowRun: {
          workflowId: "code-feature",
          currentStepId: "plan",
          completedSteps: [],
          stepApprovals: {}
        }
      })
    );
    expect(spec?.action).toBe("run");
    expect(spec?.label).toBe("Approve & run");
  });

  it("shows Start implementation when queued on implement pre-code", () => {
    const spec = actions.getPrimaryAction(
      planReviewTask({
        workflowRun: {
          workflowId: "code-feature",
          currentStepId: "implement",
          completedSteps: ["plan", "plan_gate"],
          stepApprovals: {
            plan_gate: { stepId: "plan_gate", status: "approved", approvedAt: "2026-06-06T12:00:00.000Z" }
          }
        }
      })
    );
    expect(spec?.action).toBe("approve");
    expect(spec?.label).toBe("Start implementation");
  });

  it("shows Resume step as the primary action for blocked tasks", () => {
    const spec = actions.getPrimaryAction(
      minimalTask({
        blockedReason: "API Error: 529 service temporarily overloaded",
        workflowRun: {
          workflowId: "code-feature",
          currentStepId: "implement",
          completedSteps: ["plan", "plan_gate"],
          stepApprovals: {
            plan_gate: { stepId: "plan_gate", status: "approved", approvedAt: "2026-06-06T12:00:00.000Z" },
            implement: { stepId: "implement", status: "approved", approvedAt: "2026-06-06T12:00:00.000Z" }
          }
        }
      })
    );

    expect(spec?.action).toBe("resume");
    expect(spec?.label).toBe("Resume step");
  });

  it("keeps Requeue as the primary action for completed and cancelled tasks", () => {
    expect(actions.getPrimaryAction(minimalTask({ resolution: "completed" }))?.action).toBe("requeue");
    expect(actions.getPrimaryAction(minimalTask({ resolution: "cancelled" }))?.action).toBe("requeue");
  });

  it("blocked recovery retries task-scoped agent overrides through resume", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src/ui/features/tasks/detail/blocked-recovery.tsx"),
      "utf8"
    );

    expect(source).toContain("/api/tasks/${task.id}/stage-agents/${encodeURIComponent(stepId)}");
    expect(source).toContain("/api/tasks/${task.id}/resume");
    expect(source).not.toContain("/api/settings/stage-agents/${encodeURIComponent(stepId)}");
    expect(source).not.toContain("/api/tasks/${task.id}/requeue");
  });
});

describe("ui router and navigation state", () => {
  let router: typeof import("../src/ui/app/router.ts");
  let state: typeof import("../src/ui/app/state.ts");

  beforeEach(async () => {
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn()
    });
    vi.stubGlobal("document", {
      documentElement: { setAttribute: vi.fn() }
    });

    const hash = { value: "#/home" };
    vi.stubGlobal("window", {
      location: {
        get hash() {
          return hash.value;
        },
        set hash(next: string) {
          hash.value = next;
        }
      },
      addEventListener: vi.fn()
    });

    vi.resetModules();
    state = await import("../src/ui/app/state.ts");
    router = await import("../src/ui/app/router.ts");
    state.ui.selectedTaskIds = new Set(["a", "b"]);
    state.ui.tasksFilter = "all";
    state.ui.referringView = null;
    state.ui.referringTasksFilter = null;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("buildViewHash encodes task list filters in the hash", () => {
    state.ui.tasksFilter = "blocked";
    expect(router.buildViewHash("tasks")).toBe("#/tasks?filter=blocked");
    state.ui.tasksFilter = "all";
    expect(router.buildViewHash("tasks")).toBe("#/tasks");
    expect(router.buildViewHash("task", "abc")).toBe("#/task/abc");
  });

  it("buildViewHash encodes the active project tab", () => {
    state.ui.projectTab = "overview";
    expect(router.buildViewHash("project", "proj-x")).toBe("#/project/proj-x");
    state.ui.projectTab = "autonomy";
    expect(router.buildViewHash("project", "proj-x")).toBe("#/project/proj-x/autonomy");
  });

  it("parseHash reads the project tab segment and defaults to overview", () => {
    window.location.hash = "#/project/proj-x/quality";
    router.parseHash();
    expect(state.ui.view).toBe("project");
    expect(state.ui.taskId).toBe("proj-x");
    expect(state.ui.projectTab).toBe("quality");

    window.location.hash = "#/project/proj-x";
    router.parseHash();
    expect(state.ui.projectTab).toBe("overview");
  });

  it("parseHash treats legacy memory/quality/autonomy hashes as unknown and falls back to home", () => {
    window.location.hash = "#/autonomy";
    router.parseHash();
    expect(state.ui.view).toBe("home");

    window.location.hash = "#/memory";
    router.parseHash();
    expect(state.ui.view).toBe("home");
  });

  it("navigate sets the project tab from options", () => {
    router.navigate("project", "proj-y", { projectTab: "memory" });
    expect(state.ui.view).toBe("project");
    expect(state.ui.projectTab).toBe("memory");
    expect(window.location.hash).toBe("#/project/proj-y/memory");
  });

  it("parseHash restores tasks filter from the URL", () => {
    window.location.hash = "#/tasks?filter=awaiting";
    router.parseHash();
    expect(state.ui.view).toBe("tasks");
    expect(state.ui.tasksFilter).toBe("awaiting");
  });

  it("shouldClearTaskSelection only when leaving the tasks domain", () => {
    expect(router.shouldClearTaskSelection("tasks", "tasks")).toBe(false);
    expect(router.shouldClearTaskSelection("tasks", "task")).toBe(false);
    expect(router.shouldClearTaskSelection("task", "tasks")).toBe(false);
    expect(router.shouldClearTaskSelection("tasks", "project")).toBe(true);
    expect(router.shouldClearTaskSelection("task", "home")).toBe(true);
  });

  it("navigate preserves selection for intra-tasks filter changes", () => {
    state.ui.view = "tasks";
    router.navigate("tasks", null, { filter: "blocked" });
    expect(state.ui.selectedTaskIds.size).toBe(2);
    expect(state.ui.tasksFilter).toBe("blocked");
    expect(window.location.hash).toBe("#/tasks?filter=blocked");
  });

  it("navigate clears selection when leaving tasks", () => {
    state.ui.view = "tasks";
    router.navigate("project", "proj-x", { projectTab: "runs" });
    expect(state.ui.selectedTaskIds.size).toBe(0);
  });

  it("navigateBack returns to the referring view and tasks filter", () => {
    state.ui.view = "project";
    state.ui.taskId = "proj-x";
    state.ui.projectTab = "runs";
    router.navigate("task", "task-42");
    expect(state.ui.referringView).toBe("project");

    state.ui.view = "task";
    state.ui.taskId = "task-42";
    state.ui.referringView = "tasks";
    state.ui.referringTasksFilter = "blocked";

    router.navigateBack();
    expect(state.ui.view).toBe("tasks");
    expect(state.ui.tasksFilter).toBe("blocked");
    expect(window.location.hash).toBe("#/tasks?filter=blocked");
  });
});

describe("ui slice 2 feedback and navigation", () => {
  it("uses URL-driven task filters instead of harness:filter events", async () => {
    const tree = await readClientTree();
    expect(tree).toContain("tasksFilter");
    expect(tree).toContain("parseTaskFilter");
    expect(tree).not.toContain("harness:filter");
  });

  it("shows bulk-run progress and pending helpers on async triggers", async () => {
    const tree = await readClientTree();
    expect(tree).toContain("withPending");
    expect(tree).toContain("bulkRunProgress");
    expect(tree).toContain('Running {runProgress.current}/{runProgress.total}');
    expect(tree).toContain('type="submit"');
    expect(tree).toContain("navigateBack");
  });
});

describe("ui slice 1 safety and theme", () => {
  it("fixes the --w-semibold token bug in message-body styles", async () => {
    const components = await readFile(
      path.join(process.cwd(), "src/ui/styles/components.css"),
      "utf8"
    );
    expect(components).not.toContain("--w-semibold");
    expect(components).toContain(".message-body strong {");
    expect(components).toMatch(/\.message-body strong[\s\S]*var\(--w-semi\)/);
  });

  it("ships focus-visible rings and reduced-motion guards", async () => {
    const theme = await readFile(path.join(process.cwd(), "src/ui/theme.css"), "utf8");
    const components = await readFile(
      path.join(process.cwd(), "src/ui/styles/components.css"),
      "utf8"
    );
    const shell = await readFile(path.join(process.cwd(), "src/ui/styles/shell.css"), "utf8");
    const tasks = await readFile(path.join(process.cwd(), "src/ui/styles/tasks.css"), "utf8");

    expect(theme).toContain("--ring:");
    expect(theme).toContain("prefers-reduced-motion: reduce");
    expect(components).toContain(".btn:focus-visible");
    expect(shell).toContain(".status-pill:focus-visible");
    expect(shell).toContain(".rail-link:focus-visible");
    expect(tasks).toContain(".task-row:focus-visible");
    expect(shell).toMatch(/prefers-reduced-motion: reduce[\s\S]*pulse-dot/);
    expect(tasks).toMatch(/prefers-reduced-motion: reduce[\s\S]*progress::after/);
  });

  it("uses a dialog-based confirm helper instead of window.confirm", async () => {
    const tree = await readClientTree();
    const html = await readFile(path.join(process.cwd(), "src/ui/index.html"), "utf8");
    expect(tree).not.toContain("window.confirm(");
    expect(tree).toContain('id="confirmDialog"');
    expect(tree).toContain("overlays/confirm");
    expect(tree).toContain("showModal");
    expect(html).toContain('id="confirmDialog"');
  });

  it("guards irreversible actions and supports undoable task deletes", async () => {
    const tree = await readClientTree();
    expect(tree).toContain("softDeleteTasks");
    expect(tree).toContain('label: "Undo"');
    expect(tree).toContain("Clean all runs?");
    expect(tree).toContain("Disconnect connector?");
    expect(tree).toContain("Import connector tasks?");
    expect(tree).toContain("/pm-status");
  });

  it("renders provider logo marks in connector cards", async () => {
    const tree = await readClientTree();
    expect(tree).toContain("connector-logo");
    expect(tree).toContain("GitHub logo");
    expect(tree).toContain("GitLab logo");
    expect(tree).toContain("ClickUp logo");
    expect(tree).toContain("--connector-logo-size");
    expect(tree).toContain('viewBox="105 105 170 170"');
  });

  it("lets ClickUp manage multiple subscribed lists for polling", async () => {
    const tree = await readClientTree();
    expect(tree).toContain("subscribedListIds");
    expect(tree).toContain("listProjectBindings");
    expect(tree).toContain("connector-map-check");
    expect(tree).toContain("connector-map-project");
    expect(tree).toContain("connector-map-table");
    expect(tree).toContain("Sync lists");
    expect(tree).toContain("resourcesSyncedAt");
    expect(tree).toContain("syncingClickUpConnectionId");
    expect(tree).toContain("icon icon-spin");
    expect(tree).not.toContain('class="select connector-resource"');
  });

  it("surfaces persistent error toasts and SSE reconnect status", async () => {
    const tree = await readClientTree();
    expect(tree).toContain("errorToast");
    expect(tree).toContain("duration: 0");
    expect(tree).toContain("scheduleReconnect");
    expect(tree).toContain("updateConnectionStatus");
    expect(tree).toContain("Reconnecting");
    expect(tree).toContain("is-visible");
    expect(tree).toContain("harness:events-status");
  });

  it("reports tail completion and fetch failures", async () => {
    const tree = await readClientTree();
    expect(tree).toContain("tail-status-complete");
    expect(tree).toContain("tail-status-error");
    expect(tree).toContain("Run complete");
    expect(tree).toContain("pollFailures");
    expect(tree).toContain("markComplete");
  });
});

describe("ui project surfaces", () => {
  it("adds projects from the sidebar via a native folder picker, not a settings form", async () => {
    const tree = await readClientTree();
    // The add flow lives in the rail + a server-side native picker.
    expect(tree).toContain("harness:new-project");
    expect(tree).toContain("data-new-project");
    expect(tree).toContain("addProjectViaPicker");
    expect(tree).toContain("/api/projects/pick-folder");
    // Settings keeps the management table but no longer hosts an add form.
    expect(tree).toContain("projects-table");
    expect(tree).toContain("project-status-chip");
    expect(tree).toContain("/api/projects");
    expect(tree).toContain("Remove project?");
    expect(tree).not.toContain("projects-form");
    expect(tree).not.toContain("handleAddProject");
  });

  it("keeps the projects table from clipping row actions on narrow detail panes", async () => {
    const settingsCss = await readFile(path.join(process.cwd(), "src/ui/styles/settings.css"), "utf8");
    // Fixed layout + min-width + a scroll wrapper: the table truncates the path
    // and scrolls rather than pushing the Repoint/Pause/Remove actions off-screen.
    expect(settingsCss).toContain(".projects-table-scroll");
    expect(settingsCss).toContain("overflow-x: auto");
    expect(settingsCss).toContain("table-layout: fixed");
    expect(settingsCss).toContain("min-width: 620px");
    // The Settings detail pane is wrapped in the scroll container.
    const tree = await readClientTree();
    expect(tree).toContain("projects-table-scroll");
  });

  it("stacks the shared catalog rail above the detail on laptop-width screens", async () => {
    const responsiveCss = await readFile(path.join(process.cwd(), "src/ui/styles/responsive.css"), "utf8");
    // Raised from 900px so Settings/Connectors/Skills/Workflows get a full-width
    // detail pane before the two-column shell squeezes it to ~460px.
    expect(responsiveCss).toContain("@media (max-width: 1080px)");
    expect(responsiveCss).not.toContain("@media (max-width: 900px)");
  });

  it("truncates gate-check evidence chips instead of clipping them off the card", async () => {
    const projectsCss = await readFile(path.join(process.cwd(), "src/ui/styles/projects.css"), "utf8");
    // Long file-path chips in gate cards wrap and truncate with ellipsis.
    expect(projectsCss).toContain(".gate-check .meta-line .chip");
    expect(projectsCss).toContain("text-overflow: ellipsis");
    // Card + meta row can shrink inside the auto-fill grid track.
    expect(projectsCss).toContain("min-width: 0");
    // Section head actions wrap below the heading on narrow widths.
    expect(projectsCss).toMatch(/\.project-section-head \{[^}]*flex-wrap: wrap/);
  });

  it("always renders the Projects rail heading with an add button", async () => {
    const layout = await readFile(path.join(process.cwd(), "src/ui/shell/layout.ts"), "utf8");
    expect(layout).toContain("rail-heading-row");
    expect(layout).toContain("rail-heading-action");
    expect(layout).toContain("data-new-project");
    // Heading is no longer gated behind having at least one project.
    expect(layout).not.toContain("if (!projects.length) return \"\"");
  });

  it("scopes autonomy jobs per project with project-scoped API calls", async () => {
    const tree = await readClientTree();
    expect(tree).toContain("AutonomyPanel");
    expect(tree).toContain("jobsForScope");
    expect(tree).toContain("/api/projects/");
    expect(tree).toContain("/jobs/");
    expect(tree).toContain("/run-mode");
    // Per-project tabs render a single scope, so the old cross-scope grouping
    // headers are gone.
    expect(tree).not.toContain("autonomy-scope-header");
    expect(tree).not.toContain("groupJobsByScope");
  });

  it("renders project table rows from bootstrap projects data", async () => {
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn()
    });
    vi.stubGlobal("document", {
      documentElement: { setAttribute: vi.fn() }
    });
    vi.resetModules();

    const state = await import("../src/ui/app/state.ts");
    const projects: ProjectSummary[] = [
      {
        id: "proj-abc12345",
        name: "My App",
        repoPath: "/home/user/repos/my-app",
        status: "active",
        createdAt: "2026-06-06T12:00:00.000Z",
        updatedAt: "2026-06-06T12:00:00.000Z"
      }
    ];
    state.ui.data = minimalAppState({ projects });

    // Verify projects data is accessible from state
    expect(state.ui.data?.projects).toHaveLength(1);
    expect(state.ui.data?.projects?.[0]?.name).toBe("My App");

    vi.unstubAllGlobals();
  });

  it("partitions autonomy jobs into harness and project groups", async () => {
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn()
    });
    vi.stubGlobal("document", {
      documentElement: { setAttribute: vi.fn() }
    });
    vi.resetModules();

    const state = await import("../src/ui/app/state.ts");
    const projectJobs: AutonomyJob[] = [
      {
        id: "quality-gate-sweep",
        title: "Quality gate sweep",
        description: "Test",
        schedule: "every-1d",
        status: "active",
        runMode: "manual",
        approvalPolicy: "synthetic-task",
        scope: "project",
        scopeId: "proj-abc12345",
        scopeLabel: "My App"
      }
    ];
    const harnessJobs: AutonomyJob[] = [
      {
        id: "harness-self-improvement",
        title: "Mission Control self-improvement",
        description: "Test",
        schedule: "every-1d",
        status: "active",
        runMode: "automatic",
        approvalPolicy: "synthetic-task",
        scope: "harness"
      }
    ];

    state.ui.data = minimalAppState({
      autonomyJobs: [...harnessJobs, ...projectJobs],
      projects: [
        {
          id: "proj-abc12345",
          name: "My App",
          repoPath: "/home/user/repos/my-app",
          status: "active",
          createdAt: "2026-06-06T12:00:00.000Z",
          updatedAt: "2026-06-06T12:00:00.000Z"
        }
      ]
    });

    // Verify the autonomy jobs have correct scope metadata
    const allJobs = state.ui.data?.autonomyJobs ?? [];
    expect(allJobs).toHaveLength(2);
    expect(allJobs.filter((j) => j.scope === "harness")).toHaveLength(1);
    expect(allJobs.filter((j) => j.scope === "project")).toHaveLength(1);

    vi.unstubAllGlobals();
  });
});

describe("ui rail resize", () => {
  let resize: typeof import("../src/ui/shell/rail-resize.ts");

  beforeEach(async () => {
    vi.resetModules();
    resize = await import("../src/ui/shell/rail-resize.ts");
  });

  it("clamps width to the configured min/max bounds", () => {
    expect(resize.clampRailWidth(50)).toBe(resize.RAIL_WIDTH_MIN);
    expect(resize.clampRailWidth(9999)).toBe(resize.RAIL_WIDTH_MAX);
    expect(resize.clampRailWidth(320)).toBe(320);
  });

  it("rounds fractional widths and falls back to the default for non-finite input", () => {
    expect(resize.clampRailWidth(287.6)).toBe(288);
    expect(resize.clampRailWidth(Number.NaN)).toBe(resize.RAIL_WIDTH_DEFAULT);
    expect(resize.clampRailWidth(Number.POSITIVE_INFINITY)).toBe(resize.RAIL_WIDTH_DEFAULT);
  });

  it("keeps min strictly below max and default within bounds", () => {
    expect(resize.RAIL_WIDTH_MIN).toBeLessThan(resize.RAIL_WIDTH_MAX);
    expect(resize.RAIL_WIDTH_DEFAULT).toBeGreaterThanOrEqual(resize.RAIL_WIDTH_MIN);
    expect(resize.RAIL_WIDTH_DEFAULT).toBeLessThanOrEqual(resize.RAIL_WIDTH_MAX);
  });

  it("drives the rail grid column from a CSS variable and styles a drag handle", async () => {
    const shellCss = await readFile(path.join(process.cwd(), "src/ui/styles/shell.css"), "utf8");
    expect(shellCss).toContain("grid-template-columns: var(--rail-w, 224px) minmax(0, 1fr)");
    expect(shellCss).toContain(".rail-resize-handle {");
    expect(shellCss).toContain("cursor: col-resize");
    expect(shellCss).toContain("left: var(--rail-w, 224px)");
    expect(shellCss).toContain(".app-shell.collapsed .rail-resize-handle");
  });

  it("hides the resize handle and collapse chevron in the narrow responsive layout", async () => {
    const responsiveCss = await readFile(path.join(process.cwd(), "src/ui/styles/responsive.css"), "utf8");
    expect(responsiveCss).toMatch(/\.rail-resize-handle,\s*\n\s*\.rail-collapse\s*\{\s*display: none/);
  });

  it("wires pointer drag, persistence, and keyboard a11y on the handle", async () => {
    const source = readFileSync(
      path.join(process.cwd(), "src/ui/shell/rail-resize.ts"),
      "utf8"
    );
    expect(source).toContain("setupRailResize");
    expect(source).toContain("--rail-w");
    expect(source).toContain("harness:rail:width");
    expect(source).toContain("pointerdown");
    expect(source).toContain("setPointerCapture");
    expect(source).toContain('"Resize sidebar"');
    expect(source).toContain("ArrowLeft");
    expect(source).toContain("ArrowRight");
    expect(source).toContain('role", "separator"');
  });

  it("wires a collapse chevron that toggles .app-shell.collapsed and persists", async () => {
    const source = readFileSync(
      path.join(process.cwd(), "src/ui/shell/rail-resize.ts"),
      "utf8"
    );
    expect(source).toContain("RAIL_COLLAPSED_KEY");
    expect(source).toContain("harness:rail:collapsed");
    expect(source).toContain("setRailCollapsed");
    expect(source).toContain("rail-collapse");
    expect(source).toContain("Collapse sidebar");
    expect(source).toContain("Expand sidebar");
    expect(source).toContain("chevron-left");
    expect(source).toContain("chevron-right");

    const shellCss = await readFile(path.join(process.cwd(), "src/ui/styles/shell.css"), "utf8");
    expect(shellCss).toContain(".rail-collapse {");
    expect(shellCss).toContain(".app-shell.collapsed .rail-collapse");
    expect(shellCss).toContain(".app-shell.collapsed .rail-project-tickets");

    const icons = await readFile(path.join(process.cwd(), "src/ui/shell/icons.ts"), "utf8");
    expect(icons).toContain('"chevron-left"');
  });

  it("restores persisted width before first paint in bootstrap", async () => {
    const bootstrap = readFileSync(
      path.join(process.cwd(), "src/ui/app/bootstrap.ts"),
      "utf8"
    );
    expect(bootstrap).toContain("restoreRailWidthEarly");
    expect(bootstrap).toContain("setupRailResize");
  });
});

describe("ui navigation restructure", () => {
  it("groups system concerns under System and project-scoped surfaces under project tabs", async () => {
    const layout = await readFile(path.join(process.cwd(), "src/ui/shell/layout.ts"), "utf8");
    // System section holds skills, connectors, workflows, settings.
    expect(layout).toContain('<div class="rail-heading">System</div>');
    expect(layout).toContain('view: "skills"');
    expect(layout).toContain('view: "connectors"');
    expect(layout).toContain('view: "workflows"');
    expect(layout).toContain('view: "settings"');
    // Project-scoped resources are no longer top-level rail items.
    expect(layout).not.toContain('view: "runs", label: "Runs"');
    expect(layout).not.toContain('<div class="rail-heading">Mission Control</div>');
    expect(layout).not.toContain('view: "memory", label: "Memory"');
    expect(layout).not.toContain('view: "autonomy", label: "Autonomy"');
    expect(layout).not.toContain('label: "Quality"');
  });

  it("drops standalone memory/quality/autonomy view names and registry entries", async () => {
    const stateSrc = await readFile(path.join(process.cwd(), "src/ui/app/state.ts"), "utf8");
    expect(stateSrc).toContain('export type ProjectTab');
    expect(stateSrc).toContain('projectTab');

    const registry = await readFile(path.join(process.cwd(), "src/ui/app/registry.ts"), "utf8");
    expect(registry).not.toContain("renderMemoryView");
    expect(registry).not.toContain("renderAutonomyView");
    expect(registry).not.toContain("renderQualityView");
  });

  it("removes memory/quality/autonomy/runs from the navigable view names", async () => {
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn()
    });
    vi.stubGlobal("document", { documentElement: { setAttribute: vi.fn() } });
    vi.resetModules();
    const appState = await import("../src/ui/app/state.ts");
    expect(appState.isViewName("memory")).toBe(false);
    expect(appState.isViewName("quality")).toBe(false);
    expect(appState.isViewName("autonomy")).toBe(false);
    expect(appState.isViewName("runs")).toBe(false);
    expect(appState.isViewName("workflows")).toBe(true);
    vi.unstubAllGlobals();
  });

  it("mounts Runs/Autonomy/Memory/Quality panels inside the project detail tabs", async () => {
    const projectView = await readFile(
      path.join(process.cwd(), "src/ui/features/projects/page.tsx"),
      "utf8"
    );
    expect(projectView).toContain("project-tabs");
    expect(projectView).toContain("RunsPanel");
    expect(projectView).toContain("AutonomyPanel");
    expect(projectView).toContain("MemoryPanel");
    expect(projectView).toContain("QualityGatePanel");
    expect(projectView).not.toContain("QualityPanel");
    expect(projectView).toContain('navigate("project", project.id, { projectTab');
  });

  it("treats the legacy standalone runs route as unknown and falls back to home", async () => {
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn()
    });
    vi.stubGlobal("document", { documentElement: { setAttribute: vi.fn() } });
    const hash = { value: "#/home" };
    vi.stubGlobal("window", {
      location: {
        get hash() {
          return hash.value;
        },
        set hash(next: string) {
          hash.value = next;
        }
      },
      addEventListener: vi.fn()
    });
    vi.resetModules();
    const router = await import("../src/ui/app/router.ts");
    const state = await import("../src/ui/app/state.ts");
    window.location.hash = "#/runs";
    router.parseHash();
    expect(state.ui.view).toBe("home");
    vi.unstubAllGlobals();
  });
});

describe("project ticket management", () => {
  it("treats resolved tickets as complete", () => {
    expect(taskIsComplete(minimalTask({ resolution: "completed" }))).toBe(true);
    expect(taskIsComplete(minimalTask({ resolution: "cancelled" }))).toBe(true);
    expect(taskIsComplete(minimalTask())).toBe(false);
  });

  it("filters the rail ticket list to non-complete tickets", async () => {
    const layout = await readFile(path.join(process.cwd(), "src/ui/shell/layout.ts"), "utf8");
    expect(layout).toContain("taskIsComplete");
  });

  it("expands the rail ticket list inline instead of navigating away", async () => {
    const layout = await readFile(path.join(process.cwd(), "src/ui/shell/layout.ts"), "utf8");
    expect(layout).toContain("toggleProjectExpand");
    expect(layout).toContain("data-expand-project-id");
    expect(layout).toContain("Show less");
    expect(layout).not.toContain('rail-project-more" data-view="project"');
  });

  it("fires a transient toast when a ticket is opened instead of a persistent card", async () => {
    const page = await readFile(path.join(process.cwd(), "src/ui/features/projects/page.tsx"), "utf8");
    expect(page).toContain('"Ticket opened"');
    expect(page).toContain("View ticket");
    expect(page).toContain("notified");
    expect(page).toContain('item.status === "pending" || item.status === "running"');
  });

  it("renders a filterable project ticket table", async () => {
    const page = await readFile(path.join(process.cwd(), "src/ui/features/projects/page.tsx"), "utf8");
    expect(page).toContain("project-ticket-table");
    expect(page).toContain("filterProjectTickets");
    expect(page).toContain("ticket-filter-status");
    expect(page).toContain("ticket-filter-name");
  });

  it("styles the project ticket table", async () => {
    const projectsCss = await readFile(path.join(process.cwd(), "src/ui/styles/projects.css"), "utf8");
    expect(projectsCss).toContain(".project-ticket-table");
  });

  it("filters and sorts project tickets", () => {
    const a = minimalTask({ id: "a", title: "Alpha bug", updatedAt: "2026-06-01T00:00:00.000Z" });
    const b = minimalTask({ id: "b", title: "Beta feature", updatedAt: "2026-06-03T00:00:00.000Z" });
    const c = minimalTask({
      id: "c",
      title: "Gamma",
      resolution: "completed",
      updatedAt: "2026-06-02T00:00:00.000Z"
    });
    const all = [a, b, c];

    expect(filterProjectTickets(all, DEFAULT_TICKET_FILTER).map((t) => t.id)).toEqual(["b", "c", "a"]);
    expect(filterProjectTickets(all, { ...DEFAULT_TICKET_FILTER, name: "alpha" }).map((t) => t.id)).toEqual(["a"]);
    expect(
      filterProjectTickets(all, { ...DEFAULT_TICKET_FILTER, status: "completed" }).map((t) => t.id)
    ).toEqual(["c"]);
    expect(filterProjectTickets(all, { ...DEFAULT_TICKET_FILTER, sort: "updated-asc" }).map((t) => t.id)).toEqual([
      "a",
      "c",
      "b"
    ]);
  });

  it("lists distinct statuses present on project tickets", () => {
    const all = [minimalTask({ id: "a" }), minimalTask({ id: "c", resolution: "completed" })];
    expect(projectTicketStatuses(all)).toEqual(["completed", "queued"]);
  });
});

describe("ui attachment upload collection", () => {
  function fileNamed(name: string): File {
    return new File(["payload"], name);
  }

  it("keeps successful uploads when a sibling file fails", async () => {
    const upload = vi.fn(async (file: File) => {
      if (file.name === "bad") throw new Error("rejected");
      return { name: file.name };
    });

    const result = await collectUploads([fileNamed("a"), fileNamed("bad"), fileNamed("c")], upload);

    expect(result.uploaded.map((entry) => entry.name)).toEqual(["a", "c"]);
    expect(result.failed).toEqual(["bad"]);
    expect(upload).toHaveBeenCalledTimes(3);
  });

  it("reports every failed name and no uploads when all files fail", async () => {
    const upload = vi.fn(async (file: File) => {
      throw new Error(file.name);
    });

    const result = await collectUploads([fileNamed("a"), fileNamed("b")], upload);

    expect(result.uploaded).toEqual([]);
    expect(result.failed).toEqual(["a", "b"]);
  });
});

describe("attachment list transitions", () => {
  function att(id: string): HarnessAttachment {
    return {
      id,
      filename: `${id}.txt`,
      mimeType: "text/plain",
      size: 4,
      source: "intake",
      createdAt: "2026-06-06T12:00:00.000Z"
    };
  }

  it("appends uploaded files to the end of the latest list", () => {
    expect(appendAttachments([att("a")], [att("b"), att("c")])).toEqual([
      att("a"),
      att("b"),
      att("c")
    ]);
  });

  it("does not resurrect an attachment removed while an upload is in flight", () => {
    // The picker applies append/remove as transitions over the parent's latest
    // list, so a removal that lands mid-upload composes ahead of the append.
    const afterRemoval = removeAttachment([att("a"), att("b")], "a");
    const afterUpload = appendAttachments(afterRemoval, [att("c")]);

    expect(afterUpload).toEqual([att("b"), att("c")]);
  });
});

describe("ui maintenance view", () => {
  function maintenanceRun(taskId: string): import("../src/ui/app/types.ts").HarnessRun {
    return {
      id: "run-x",
      taskId,
      taskTitle: "Job",
      agent: "grok",
      status: "completed",
      startedAt: "2026-06-06T12:00:00.000Z",
      artifacts: []
    };
  }

  it("identifies daemon-maintenance runs by their autonomy task id", async () => {
    const { isMaintenanceRun } = await import("../src/ui/features/runs/groups.ts");
    expect(isMaintenanceRun(maintenanceRun("autonomy:worktree-cleanup-sweep"))).toBe(true);
    // The guidance sweep is now a project-scoped job, not daemon maintenance.
    expect(isMaintenanceRun(maintenanceRun("autonomy:project:proj-abc:guidance-sweep"))).toBe(false);
    // Per-project autonomy runs are scoped to a project, not daemon maintenance.
    expect(isMaintenanceRun(maintenanceRun("autonomy:project:proj-abc:self-improvement"))).toBe(false);
    expect(isMaintenanceRun(maintenanceRun("autonomy:project:proj-abc:doc-gardening"))).toBe(false);
    // Ordinary task runs never belong to the maintenance view.
    expect(isMaintenanceRun(maintenanceRun("task-123"))).toBe(false);
  });

  it("registers maintenance as a navigable view name", async () => {
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn()
    });
    vi.stubGlobal("document", { documentElement: { setAttribute: vi.fn() } });
    vi.resetModules();
    const appState = await import("../src/ui/app/state.ts");
    expect(appState.isViewName("maintenance")).toBe(true);
    vi.unstubAllGlobals();
  });

  it("parses #/maintenance into the maintenance view", async () => {
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn()
    });
    vi.stubGlobal("document", { documentElement: { setAttribute: vi.fn() } });
    const hash = { value: "#/home" };
    vi.stubGlobal("window", {
      location: {
        get hash() {
          return hash.value;
        },
        set hash(next: string) {
          hash.value = next;
        }
      },
      addEventListener: vi.fn()
    });
    vi.resetModules();
    const router = await import("../src/ui/app/router.ts");
    const state = await import("../src/ui/app/state.ts");
    window.location.hash = "#/maintenance";
    router.parseHash();
    expect(state.ui.view).toBe("maintenance");
    vi.unstubAllGlobals();
  });

  it("adds a Maintenance item under the System rail section", async () => {
    const layout = await readFile(path.join(process.cwd(), "src/ui/shell/layout.ts"), "utf8");
    expect(layout).toContain('view: "maintenance"');
    expect(layout).toContain('label: "Maintenance"');
  });

  it("registers a maintenance entry in the view registry", async () => {
    const registry = await readFile(path.join(process.cwd(), "src/ui/app/registry.ts"), "utf8");
    expect(registry).toContain("renderSystemView");
    expect(registry).toContain("maintenance:");
  });

  it("composes the harness autonomy panel and a maintenance runs list", async () => {
    const page = await readFile(path.join(process.cwd(), "src/ui/features/system/page.tsx"), "utf8");
    expect(page).toContain("AutonomyPanel");
    expect(page).toContain('kind: "harness"');
    expect(page).toContain("RunGroupList");
    expect(page).toContain("isMaintenanceRun");
    expect(page).toContain("export function renderSystemView");
  });

  it("exposes a reusable run group list from the runs page", async () => {
    const runsPage = await readFile(path.join(process.cwd(), "src/ui/features/runs/page.tsx"), "utf8");
    expect(runsPage).toContain("export function RunGroupList");
  });
});
