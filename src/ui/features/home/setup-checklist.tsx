import { useEffect, useState } from "preact/hooks";

import { ui } from "@ui/app/state.js";
import { navigate } from "@ui/app/router.js";
import { api } from "@ui/data/api.js";
import { icon } from "@ui/shell/icons.js";
import {
  cliSetupDone,
  type ToolPresenceMap
} from "../settings/agents/tool-setup.js";
import { CliOnboardingModal } from "./cli-onboarding-modal.js";

const SETUP_DISMISSED_KEY = "harness:setup-dismissed";

function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return <span dangerouslySetInnerHTML={{ __html: icon(name, size) }} />;
}

function readSetupDismissed(): boolean {
  return localStorage.getItem(SETUP_DISMISSED_KEY) === "1";
}

function writeSetupDismissed(): void {
  localStorage.setItem(SETUP_DISMISSED_KEY, "1");
}

export function SetupChecklist({ hasProjects }: { hasProjects: boolean }) {
  const [dismissed, setDismissed] = useState(readSetupDismissed());
  const [cliOpen, setCliOpen] = useState(false);
  const [presence, setPresence] = useState<ToolPresenceMap>({});
  const [probing, setProbing] = useState(false);
  const tools = ui.data?.agentConfig?.tools ?? [];

  async function probe(toolId?: string): Promise<void> {
    setProbing(true);
    try {
      const result = await api<{ runtimeDiagnostics?: ToolPresenceMap }>("/api/agent-config/probe", {
        method: "POST",
        body: JSON.stringify(toolId ? { toolId } : {})
      });
      if (result?.runtimeDiagnostics) {
        setPresence((prev) =>
          toolId ? { ...prev, ...result.runtimeDiagnostics } : { ...result.runtimeDiagnostics }
        );
      }
    } catch {
      /* presence is best-effort */
    } finally {
      setProbing(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setProbing(true);
      try {
        const result = await api<{ runtimeDiagnostics?: ToolPresenceMap }>("/api/agent-config/probe", {
          method: "POST",
          body: JSON.stringify({})
        });
        if (!cancelled && result?.runtimeDiagnostics) {
          setPresence(result.runtimeDiagnostics);
        }
      } catch {
        /* presence is best-effort on first paint */
      } finally {
        if (!cancelled) setProbing(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tools.map((tool) => tool.id).join(",")]);

  function handleDismiss(): void {
    writeSetupDismissed();
    setDismissed(true);
  }

  if (dismissed) return null;

  const cliDone = cliSetupDone(tools, presence);

  const items = [
    {
      iconName: "terminal",
      title: "Install an agent CLI",
      body: "Detect installed agent CLIs, enable them, or install missing ones.",
      done: cliDone,
      action: () => setCliOpen(true)
    },
    {
      iconName: "folder",
      title: "Add your first project",
      body: hasProjects
        ? "A local git project is ready for scoped tickets."
        : "Use the + next to Projects to select a local git repository.",
      done: hasProjects
    },
    {
      iconName: "bot",
      title: "Configure agents",
      body: "Choose a default agent and confirm available CLI tools in Settings.",
      done: false,
      action: () => navigate("settings")
    },
    {
      iconName: "external-link",
      title: "Connect GitHub or GitLab",
      body: "Optional: add a connector only when you want PR or MR workflows.",
      done: false,
      action: () => navigate("connectors")
    },
    {
      iconName: "play",
      title: "Run a quickstart",
      body: "Open a project and pick one of its generated quickstarts to see the workflow loop.",
      done: false
    }
  ];

  return (
    <>
      <section class="home-setup-checklist" aria-labelledby="homeSetupTitle">
        <div class="project-section-head">
          <div>
            <h2 id="homeSetupTitle">First run setup</h2>
            <p class="home-setup-subtitle">Recommended order before the first real ticket.</p>
          </div>
          <div class="home-setup-head-actions">
            <span class="badge">{items.filter((item) => item.done).length}/{items.length}</span>
            <button
              class="btn btn-ghost btn-icon home-setup-dismiss"
              type="button"
              aria-label="Dismiss first run setup"
              title="Dismiss"
              onClick={handleDismiss}
            >
              <Icon name="x" size={14} />
            </button>
          </div>
        </div>
        <div class="home-setup-grid">
          {items.map((item) => {
            const content = (
              <>
                <span class={`home-setup-icon${item.done ? " is-done" : ""}`}>
                  <Icon name={item.done ? "check" : item.iconName} size={16} />
                </span>
                <span class="home-setup-copy">
                  <strong>{item.title}</strong>
                  <span>{item.body}</span>
                </span>
                {item.action ? <Icon name="chevron-right" size={15} /> : null}
              </>
            );

            return item.action ? (
              <button class="home-setup-item is-action" type="button" key={item.title} onClick={item.action}>
                {content}
              </button>
            ) : (
              <div class="home-setup-item" key={item.title}>
                {content}
              </div>
            );
          })}
        </div>
      </section>
      <CliOnboardingModal
        open={cliOpen}
        tools={tools}
        presence={presence}
        probing={probing}
        onClose={() => setCliOpen(false)}
        onRescan={(toolId) => probe(toolId)}
      />
    </>
  );
}
