import type { HarnessSettings } from "../../../core/settings.ts";
import type { ComponentChildren, VNode } from "preact";
import { useEffect, useState } from "preact/hooks";
import { render } from "preact";
import { api } from "@ui/data/api.js";
import { $ } from "@ui/shell/dom.js";
import { icon } from "@ui/shell/icons.js";
import { type VersionStatus } from "@ui/shell/update-pill.js";
import { setTheme, ui, relativeTime } from "@ui/app/state.js";
import { toast } from "@ui/overlays/toast.js";
import { confirm } from "@ui/overlays/confirm.js";
import { DefaultAgentControl } from "./agents/section.js";
import { AgentConfigSection } from "./agents/config-section.js";
import type { ProjectSummary } from "@ui/app/types.js";

const THEME_OPTIONS = ["dark", "light"] as const;

type SettingsSection = "agents" | "monitoring" | "projects" | "workspace" | "appearance" | "about";

const SECTION_GROUPS: Array<{
  label: string;
  items: Array<{ id: SettingsSection; icon: string; name: string; sub: string }>;
}> = [
  {
    label: "Agents & execution",
    items: [
      { id: "agents", icon: "bot", name: "Agents", sub: "Default agent · tools & pools" },
      { id: "monitoring", icon: "clock", name: "Monitoring", sub: "Stall & long-run warnings" }
    ]
  },
  {
    label: "Workspace",
    items: [
      { id: "projects", icon: "inbox", name: "Projects", sub: "Onboarded repositories" },
      { id: "workspace", icon: "folder", name: "Workspace", sub: "Projects root path" }
    ]
  },
  {
    label: "Application",
    items: [
      { id: "appearance", icon: "sun", name: "Appearance", sub: "Theme" },
      { id: "about", icon: "settings", name: "About", sub: "Environment details" }
    ]
  }
];

const SECTION_HEADS: Record<SettingsSection, { icon: string; title: string; desc: string }> = {
  agents: {
    icon: "bot",
    title: "Agents",
    desc: "Tools and model pools for automated turns. Routing favors quality, then quota and cost."
  },
  monitoring: {
    icon: "clock",
    title: "Monitoring",
    desc: "When to surface stall and long-running warnings on active tasks."
  },
  projects: {
    icon: "inbox",
    title: "Projects",
    desc: "Onboarded git repos receive Mission Control autonomy: quality grading, tech debt sweeps, and error triage. Add one from the + next to Projects in the sidebar."
  },
  workspace: {
    icon: "folder",
    title: "Workspace",
    desc: "Paths used for target suggestions and memory indexing outside Mission Control."
  },
  appearance: {
    icon: "sun",
    title: "Appearance",
    desc: "Visual preferences for Mission Control."
  },
  about: {
    icon: "settings",
    title: "About",
    desc: "Read-only environment details for this Mission Control instance."
  }
};

const DEFAULT_SETTINGS: HarnessSettings = {
  defaultAgent: "grok",
  activityThresholds: { staleMs: 240_000, longRunMs: 1_200_000 },
  theme: "dark",
  projectsRoot: ""
};

function minutesFromMs(ms: number): number {
  return Math.round(ms / 60_000);
}

function msFromMinutes(minutes: number): number {
  return Math.max(1, Math.floor(minutes)) * 60_000;
}

function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return <span dangerouslySetInnerHTML={{ __html: icon(name, size) }} />;
}

function IdHead({ section, actions }: { section: SettingsSection; actions?: ComponentChildren }) {
  const head = SECTION_HEADS[section];
  return (
    <div class="catalog-id-head">
      <div class="catalog-id-logo">
        <Icon name={head.icon} size={26} />
      </div>
      <div class="catalog-id-text">
        <div class="catalog-id-title">{head.title}</div>
        <div class="catalog-id-account settings-id-desc">{head.desc}</div>
      </div>
      {actions ? <div class="catalog-id-actions">{actions}</div> : null}
    </div>
  );
}

function SettingsRow({
  label,
  description,
  children
}: {
  label: string;
  description: string;
  children: ComponentChildren;
}) {
  return (
    <div class="settings-row">
      <div class="settings-row-copy">
        <div class="settings-row-label">{label}</div>
        <div class="settings-row-desc">{description}</div>
      </div>
      <div class="settings-row-control">{children}</div>
    </div>
  );
}

function ProjectsSection(): VNode {
  const projects = ui.data?.projects ?? [];

  async function handleToggleStatus(project: ProjectSummary): Promise<void> {
    const next = project.status === "active" ? "paused" : "active";
    try {
      await api(`/api/projects/${project.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: next })
      });
      document.dispatchEvent(new CustomEvent("harness:refresh"));
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to update project.", { tone: "error" });
    }
  }

  async function handleRemoveProject(project: ProjectSummary): Promise<void> {
    const ok = await confirm({
      title: "Remove project?",
      message: `Remove "${project.name}" and delete its autonomy state (quality grades, tech debt, run history).`,
      confirmLabel: "Remove",
      tone: "danger"
    });
    if (!ok) return;
    try {
      await api(`/api/projects/${project.id}`, { method: "DELETE" });
      toast(`Project "${project.name}" removed.`, { tone: "success" });
      document.dispatchEvent(new CustomEvent("harness:refresh"));
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to remove project.", { tone: "error" });
    }
  }

  if (!projects.length) {
    return (
      <div class="catalog-panel">
        <div class="projects-empty">No projects onboarded yet. Use the + next to Projects in the sidebar to select a folder.</div>
      </div>
    );
  }

  return (
    <table class="projects-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Path</th>
          <th>Status</th>
          <th>Last seen</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {projects.map((project) => (
          <tr key={project.id}>
            <td>{project.name}</td>
            <td><span class="project-repo-path" title={project.repoPath}>{project.repoPath}</span></td>
            <td>
              <span class={`project-status-chip is-${project.status}`}>
                <span class="project-status-dot" />
                {project.status}
              </span>
            </td>
            <td>{relativeTime(project.lastSeenAt || project.updatedAt)}</td>
            <td>
              <div class="project-actions">
                <button
                  class="btn btn-sm btn-ghost"
                  type="button"
                  onClick={() => void handleToggleStatus(project)}
                  title={project.status === "active" ? "Pause" : "Resume"}
                >
                  {project.status === "active" ? "Pause" : "Resume"}
                </button>
                <button
                  class="btn btn-sm btn-danger"
                  type="button"
                  onClick={() => void handleRemoveProject(project)}
                  title="Remove"
                >
                  Remove
                </button>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SettingsView() {
  const settings = ui.data?.settings ?? DEFAULT_SETTINGS;
  const [activeSection, setActiveSection] = useState<SettingsSection>("agents");
  const [theme, setThemeValue] = useState<HarnessSettings["theme"]>(settings.theme);
  const [version, setVersion] = useState<VersionStatus | null>(null);

  useEffect(() => {
    setThemeValue(settings.theme);
  }, [settings.theme]);

  // About is read-only environment detail; fetch the live version status only
  // when that section is open (the header pill polls /api/version separately).
  useEffect(() => {
    if (activeSection !== "about") return;
    let cancelled = false;
    api<VersionStatus>("/api/version")
      .then((s) => {
        if (!cancelled && s) setVersion(s);
      })
      .catch(() => {
        /* network/registry hiccup: keep the last known version, if any */
      });
    return () => {
      cancelled = true;
    };
  }, [activeSection]);

  async function applyPatch(patch: Partial<HarnessSettings>, silent = true): Promise<void> {
    const updated = await api<HarnessSettings>("/api/settings", {
      method: "PATCH",
      body: JSON.stringify(patch)
    });

    if (!updated) {
      toast("Settings update failed.", { tone: "error" });
      return;
    }

    if (ui.data) {
      ui.data.settings = updated;
      ui.data.activityThresholds = updated.activityThresholds;
    }

    if (updated.theme) {
      setTheme(updated.theme);
      setThemeValue(updated.theme);
    }

    if (!silent) toast("Settings updated.", { tone: "success" });
    document.dispatchEvent(new CustomEvent("harness:refresh-render"));
  }

  async function handleThemeChange(nextTheme: HarnessSettings["theme"]): Promise<void> {
    setThemeValue(nextTheme);
    await applyPatch({ theme: nextTheme });
  }

  async function handlePickProjectsRoot(): Promise<void> {
    let pick: { path?: string; canceled?: boolean } | null;
    try {
      pick = await api<{ path?: string; canceled?: boolean }>("/api/projects/pick-folder", {
        method: "POST"
      });
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not open the folder picker.", { tone: "error" });
      return;
    }
    if (!pick || pick.canceled || !pick.path) return;
    await applyPatch({ projectsRoot: pick.path }, false);
  }

  return (
    <div class="view catalog-view settings-view">
      <div class="view-header catalog-view-header">
        <div>
          <h1 class="view-title">Settings</h1>
          <p class="view-subtitle">
            Agents, monitoring, workspace, and appearance for this Mission Control instance.
          </p>
        </div>
        <div class="settings-autosave-note muted">Changes apply automatically</div>
      </div>

      <div class="catalog-shell">
        <aside class="catalog-rail" aria-label="Settings sections">
          {SECTION_GROUPS.map((group) => (
            <div class="catalog-group" key={group.label}>
              <div class="catalog-group-head">{group.label}</div>
              {group.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  class={`catalog-item${activeSection === item.id ? " is-selected" : ""}`}
                  data-settings-section={item.id}
                  onClick={() => setActiveSection(item.id)}
                >
                  <span class="catalog-item-logo">
                    <Icon name={item.icon} size={18} />
                  </span>
                  <span class="catalog-item-meta">
                    <span class="catalog-item-name">{item.name}</span>
                    <span class="catalog-item-sub">{item.sub}</span>
                  </span>
                </button>
              ))}
            </div>
          ))}
        </aside>

        <main class="catalog-detail">
          <div class="catalog-detail-inner">
            <IdHead
              section={activeSection}
              actions={
                activeSection === "agents" ? (
                  <DefaultAgentControl settings={settings} applyPatch={applyPatch} />
                ) : undefined
              }
            />
            <form onSubmit={(e) => e.preventDefault()}>
              {activeSection === "agents" && <AgentConfigSection />}

              {activeSection === "projects" && <ProjectsSection />}

              {activeSection === "monitoring" && (
                <div class="settings-group">
                <SettingsRow
                  label="No-activity warning"
                  description="Minutes without agent output before the UI marks a running task as stale."
                >
                  <input
                    class="input settings-control"
                    type="number"
                    name="staleMinutes"
                    min={1}
                    step={1}
                    value={minutesFromMs(settings.activityThresholds.staleMs)}
                    onChange={(e) =>
                      void applyPatch({
                        activityThresholds: {
                          staleMs: msFromMinutes(Number((e.currentTarget as HTMLInputElement).value)),
                          longRunMs: settings.activityThresholds.longRunMs
                        }
                      })
                    }
                  />
                </SettingsRow>
                <SettingsRow
                  label="Long-running warning"
                  description="Minutes a single turn may run before the UI flags it as unusually long."
                >
                  <input
                    class="input settings-control"
                    type="number"
                    name="longRunMinutes"
                    min={2}
                    step={1}
                    value={minutesFromMs(settings.activityThresholds.longRunMs)}
                    onChange={(e) =>
                      void applyPatch({
                        activityThresholds: {
                          staleMs: settings.activityThresholds.staleMs,
                          longRunMs: msFromMinutes(Number((e.currentTarget as HTMLInputElement).value))
                        }
                      })
                    }
                  />
                </SettingsRow>
                </div>
              )}

              {activeSection === "appearance" && (
                <div class="settings-group">
                <SettingsRow label="Color theme" description="Choose between dark and light interface themes.">
                  <div class="settings-segmented" role="group" aria-label="Theme">
                    {THEME_OPTIONS.map((option) => (
                      <label
                        key={option}
                        class={`settings-segment${theme === option ? " is-active" : ""}`}
                      >
                        <input
                          type="radio"
                          name="theme"
                          value={option}
                          checked={theme === option}
                          onChange={() => void handleThemeChange(option)}
                        />
                        <span>{option === "dark" ? "Dark" : "Light"}</span>
                      </label>
                    ))}
                  </div>
                </SettingsRow>
                </div>
              )}

              {activeSection === "workspace" && (
                <div class="settings-group">
                <SettingsRow
                  label="Projects root"
                  description="Directory scanned when you type @ paths or rebuild the memory index."
                >
                  <div class="settings-control-row">
                    <input
                      class="input settings-control settings-control-wide"
                      name="projectsRoot"
                      value={settings.projectsRoot}
                      placeholder="~/repos"
                      onBlur={(e) => {
                        const trimmed = (e.currentTarget as HTMLInputElement).value.trim();
                        void applyPatch(trimmed ? { projectsRoot: trimmed } : {});
                      }}
                    />
                    <button
                      type="button"
                      class="btn btn-sm btn-ghost settings-browse-btn"
                      onClick={() => void handlePickProjectsRoot()}
                      title="Choose a folder"
                    >
                      <Icon name="folder" size={14} />
                      Browse…
                    </button>
                  </div>
                </SettingsRow>
                </div>
              )}

              {activeSection === "about" && (
                <div class="settings-facts">
                  <div>
                    <div class="settings-fact-k">Version</div>
                    <div class="settings-fact-v settings-fact-mono">
                      {version?.installed ?? "—"}
                      {version?.latest ? ` (latest: ${version.latest})` : ""}
                    </div>
                    <div class="settings-fact-desc">
                      {version
                        ? version.behind
                          ? "An update is available."
                          : "Up to date with the published release."
                        : "Checking the published version…"}
                    </div>
                  </div>
                  <div class="settings-fact-wide">
                    <div class="settings-fact-k">Mission Control root</div>
                    <div class="settings-fact-v settings-fact-mono">{ui.data?.root ?? ""}</div>
                    <div class="settings-fact-desc">Active repository the server is watching.</div>
                  </div>
                  <div>
                    <div class="settings-fact-k">Settings file</div>
                    <div class="settings-fact-v settings-fact-mono">data/state/settings.json</div>
                    <div class="settings-fact-desc">On-disk location for persisted preferences.</div>
                  </div>
                </div>
              )}
            </form>
          </div>
        </main>
      </div>
    </div>
  );
}

export function renderSettingsView(): void {
  const root = $("#viewContent");
  if (!root) return;
  render(<SettingsView />, root);
}
