import { useEffect, useState } from "preact/hooks";

import type { EffortLevel } from "../../../core/types.ts";
import type {
  WorkflowDefinition,
  WorkflowStep,
  WorkflowStepAgent,
  WorkflowStepApproval,
  WorkflowStepKind
} from "../../../core/workflows/types.ts";
import { api } from "@ui/data/api.js";
import { icon } from "@ui/shell/icons.js";
import { withPending } from "@ui/shell/dom.js";
import { ui } from "@ui/app/state.js";
import { errorToast, toast } from "@ui/overlays/toast.js";
import { confirm } from "@ui/overlays/confirm.js";
import {
  APPROVAL_OPTIONS,
  EFFORT_OPTIONS,
  STEP_AGENT_ROLES,
  WORKFLOW_KINDS,
  kindLabel,
  type AgentOption,
  type StepPatch
} from "./options.js";
import { WorkflowCanvas } from "../tasks/detail/workflow/canvas.js";
import type { HarnessTask, WorkflowSummary } from "@ui/app/types.js";
import { ExtensionPicker } from "../extensions/picker.js";
import type { ToolExtension } from "../../../core/agents/extensions/types.ts";

interface EditorProps {
  initial: WorkflowDefinition;
  isNew: boolean;
  onClose: () => void;
  onSaved: () => void;
}

type Tab = "graph" | "yaml";
type PanelMode = "idle" | "step" | "settings";

function clone(def: WorkflowDefinition): WorkflowDefinition {
  return JSON.parse(JSON.stringify(def)) as WorkflowDefinition;
}

function stepEntries(def: WorkflowDefinition): Array<[string, WorkflowStep]> {
  return Object.entries(def.steps);
}

function terminalStepId(def: WorkflowDefinition): string | undefined {
  return stepEntries(def).find(([, step]) => step.kind === "terminal")?.[0];
}

export function WorkflowEditor({ initial, isNew, onClose, onSaved }: EditorProps) {
  const [draft, setDraft] = useState<WorkflowDefinition>(() => clone(initial));
  const [tab, setTab] = useState<Tab>("graph");
  const [yamlText, setYamlText] = useState("");
  const [yamlError, setYamlError] = useState<string | null>(null);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const agents: AgentOption[] = (ui.data?.agents ?? []) as AgentOption[];
  const registryExtensions: ToolExtension[] = ui.data?.agentExtensions?.extensions ?? [];

  // When entering the YAML tab, serialize the current draft so the text mirrors the graph.
  useEffect(() => {
    if (tab !== "yaml") return;
    void (async () => {
      try {
        const result = await api<{ yaml: string }>("/api/workflows/serialize", {
          method: "POST",
          body: JSON.stringify(draft)
        });
        setYamlText(result?.yaml ?? "");
        setYamlError(null);
      } catch (err) {
        setYamlError((err as Error).message);
      }
    })();
  }, [tab, draft]);

  function patchStep(id: string, patch: StepPatch): void {
    setDraft((d) => {
      const current = d.steps[id];
      if (!current) return d;
      const next: WorkflowStep = { ...current };
      const bag = next as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete bag[key];
        else bag[key] = value;
      }
      return { ...d, steps: { ...d.steps, [id]: next } };
    });
  }

  function changeKind(id: string, kind: WorkflowStepKind): void {
    setDraft((d) => {
      const step = d.steps[id];
      if (!step) return d;
      if (kind === "terminal") {
        const { next: _next, branch: _branch, parallel: _parallel, ...rest } = step;
        void _next;
        void _branch;
        void _parallel;
        return { ...d, steps: { ...d.steps, [id]: { ...rest, kind } } };
      }
      // Non-terminal steps need an outgoing edge; add a default next if none exists.
      const hasEdge = Boolean(step.next || step.branch || step.parallel);
      const fallbackTarget = terminalStepId(d);
      const next = !hasEdge && fallbackTarget ? fallbackTarget : step.next;
      return { ...d, steps: { ...d.steps, [id]: { ...step, kind, ...(next ? { next } : {}) } } };
    });
  }

  /** Add a new step. If a node with a linear `next` is selected, splice the new
   *  step into that edge (selected -> new -> old next). Otherwise (nothing
   *  selected, or the anchor fans out via parallel/branch) append before the
   *  terminal step so the node stays connected and visible. The new step becomes
   *  the selection. */
  function addStep(): void {
    const d = draft;
    let n = 1;
    while (d.steps[`step-${n}`]) n++;
    const id = `step-${n}`;
    const anchorId = selectedStepId ?? "";
    const anchor = anchorId ? d.steps[anchorId] : undefined;
    if (anchor && anchor.next) {
      const newStep: WorkflowStep = {
        id,
        kind: "agent_turn",
        agent: "author",
        approval: "required",
        next: anchor.next
      };
      setDraft({ ...d, steps: { ...d.steps, [id]: newStep, [anchorId]: { ...anchor, next: id } } });
    } else {
      const target = terminalStepId(d);
      const newStep: WorkflowStep = {
        id,
        kind: "agent_turn",
        agent: "author",
        approval: "required",
        ...(target ? { next: target } : {})
      };
      setDraft({ ...d, steps: { ...d.steps, [id]: newStep } });
    }
    setSelectedStepId(id);
    setShowSettings(false);
  }

  function removeStep(id: string): void {
    setDraft((d) => {
      const steps: Record<string, WorkflowStep> = {};
      for (const [stepId, step] of Object.entries(d.steps)) {
        if (stepId === id) continue;
        const next: WorkflowStep = { ...step };
        if (next.next === id) delete next.next;
        if (next.join === id) delete next.join;
        if (next.parallel) {
          const filtered = next.parallel.filter((p) => p !== id);
          if (filtered.length) next.parallel = filtered;
          else delete next.parallel;
        }
        if (next.branch) {
          for (const [event, target] of Object.entries(next.branch)) {
            if (target === id) delete next.branch[event];
          }
          if (Object.keys(next.branch).length === 0) delete next.branch;
        }
        steps[stepId] = next;
      }
      const initial = d.initial === id ? (Object.keys(steps)[0] ?? "") : d.initial;
      return { ...d, steps, initial };
    });
    setSelectedStepId((cur) => (cur === id ? null : cur));
  }

  function setBranch(id: string, branch: Record<string, string> | undefined): void {
    patchStep(id, branch && Object.keys(branch).length ? { branch } : { branch: undefined });
  }

  function selectStep(id: string): void {
    setSelectedStepId((cur) => (cur === id ? null : id));
    setShowSettings(false);
  }

  function closePanel(): void {
    setSelectedStepId(null);
    setShowSettings(false);
  }

  async function applyYaml(): Promise<void> {
    try {
      const result = await api<{ workflow: WorkflowDefinition }>("/api/workflows/parse", {
        method: "POST",
        body: JSON.stringify({ yaml: yamlText })
      });
      if (result?.workflow) {
        setDraft(result.workflow);
        setSelectedStepId(null);
        setShowSettings(false);
        setYamlError(null);
        toast("YAML applied to the graph.", { tone: "success" });
        setTab("graph");
      }
    } catch (err) {
      setYamlError((err as Error).message);
    }
  }

  async function save(event: Event): Promise<void> {
    await withPending(event.currentTarget as HTMLButtonElement, async () => {
      try {
        if (isNew) {
          await api("/api/workflows", { method: "POST", body: JSON.stringify(draft) });
          toast("Workflow created.", { tone: "success" });
        } else {
          await api(`/api/workflows/${draft.id}`, { method: "PUT", body: JSON.stringify(draft) });
          toast("Workflow saved.", { tone: "success" });
        }
        onSaved();
      } catch (err) {
        errorToast((err as Error).message);
      }
    });
  }

  async function remove(): Promise<void> {
    const ok = await confirm({
      title: `Delete workflow "${draft.name}"?`,
      message: "This removes the YAML file. The default workflow cannot be deleted.",
      confirmLabel: "Delete",
      tone: "danger"
    });
    if (!ok) return;
    try {
      await api(`/api/workflows/${draft.id}`, { method: "DELETE" });
      toast("Workflow deleted.");
      onSaved();
    } catch (err) {
      errorToast((err as Error).message);
    }
  }

  const stepIds = stepEntries(draft).map(([id]) => id);
  const selectedStep = selectedStepId ? draft.steps[selectedStepId] : undefined;
  const panelMode: PanelMode = showSettings ? "settings" : selectedStep ? "step" : "idle";
  const panelTitle =
    panelMode === "settings"
      ? "Workflow settings"
      : panelMode === "step" && selectedStepId
        ? `Stage: ${selectedStepId}`
        : "Inspector";

  return (
    <div class="view wf-editor">
      <div class="view-header">
        <div>
          <h1 class="view-title">{isNew ? "New workflow" : draft.name}</h1>
          <p class="view-subtitle">
            {isNew ? "Define a workflow; it persists as a YAML file." : `Editing ${draft.id}.yml`}
          </p>
        </div>
        <div class="row wf-header-actions">
          <button class="btn btn-ghost" type="button" onClick={onClose}>
            <span dangerouslySetInnerHTML={{ __html: icon("arrow-left", 14) }} />
            <span>Back</span>
          </button>
          {!isNew ? (
            <button class="btn btn-ghost" type="button" onClick={() => void remove()}>
              <span dangerouslySetInnerHTML={{ __html: icon("trash", 14) }} />
              <span>Delete</span>
            </button>
          ) : null}
          <button class="btn" type="button" onClick={(e) => void save(e)}>
            <span dangerouslySetInnerHTML={{ __html: icon("check", 14) }} />
            <span>{isNew ? "Create" : "Save"}</span>
          </button>
        </div>
      </div>

      <div class="wf-tabs">
        <button class={`wf-tab${tab === "graph" ? " active" : ""}`} type="button" onClick={() => setTab("graph")}>
          Graph
        </button>
        <button class={`wf-tab${tab === "yaml" ? " active" : ""}`} type="button" onClick={() => setTab("yaml")}>
          YAML
        </button>
      </div>

      {tab === "graph" ? (
        <div class="wf-editor-split">
          <div class="wf-editor-graph">
            <div class="wf-graph-toolbar">
              <button class="btn" type="button" onClick={addStep}>
                <span dangerouslySetInnerHTML={{ __html: icon("plus", 14) }} />
                <span>Add step</span>
              </button>
              <button
                class={`btn btn-ghost${showSettings ? " active" : ""}`}
                type="button"
                onClick={() => {
                  setShowSettings(true);
                  setSelectedStepId(null);
                }}
              >
                <span dangerouslySetInnerHTML={{ __html: icon("settings", 14) }} />
                <span>Workflow settings</span>
              </button>
            </div>
            <div class="wf-graph-canvas">
              <WorkflowCanvas
                task={DRAFT_TASK}
                workflow={defToSummary(draft)}
                selectedStepId={selectedStepId}
                onSelectStep={selectStep}
                fitMode="contain"
              />
            </div>
          </div>

          <aside class="wf-editor-panel">
            <div class="wf-panel">
              <div class="wf-panel-head">
                <span class="wf-panel-title">{panelTitle}</span>
                {panelMode !== "idle" ? (
                  <button class="btn btn-ghost wf-panel-close" type="button" onClick={closePanel} title="Close panel">
                    <span dangerouslySetInnerHTML={{ __html: icon("x", 14) }} />
                  </button>
                ) : null}
              </div>
              <div class="wf-panel-body">
                {panelMode === "settings" ? (
                  <WorkflowSettings
                    draft={draft}
                    setDraft={setDraft}
                    stepIds={stepIds}
                    agents={agents}
                    isNew={isNew}
                  />
                ) : panelMode === "step" && selectedStep && selectedStepId ? (
                  <StepRow
                    id={selectedStepId}
                    step={selectedStep}
                    stepIds={stepIds.filter((other) => other !== selectedStepId)}
                    agents={agents}
                    extensions={registryExtensions}
                    onPatch={(patch) => patchStep(selectedStepId, patch)}
                    onKind={(kind) => changeKind(selectedStepId, kind)}
                    onBranch={(branch) => setBranch(selectedStepId, branch)}
                    onRemove={() => removeStep(selectedStepId)}
                  />
                ) : (
                  <p class="wf-panel-empty">
                    Select a stage in the graph to edit its details, or use "Add step" to insert a new one.
                  </p>
                )}
              </div>
            </div>
          </aside>
        </div>
      ) : null}

      {tab === "yaml" ? (
        <div class="wf-yaml">
          <textarea
            class="input wf-yaml-textarea"
            spellcheck={false}
            value={yamlText}
            onInput={(e) => setYamlText((e.currentTarget as HTMLTextAreaElement).value)}
          />
          {yamlError ? <p class="wf-yaml-error">{yamlError}</p> : null}
          <div class="row">
            <button class="btn" type="button" onClick={() => void applyYaml()}>
              <span dangerouslySetInnerHTML={{ __html: icon("check", 14) }} />
              <span>Apply YAML to graph</span>
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

interface StepRowProps {
  id: string;
  step: WorkflowStep;
  stepIds: string[];
  agents: AgentOption[];
  extensions: ToolExtension[];
  onPatch: (patch: StepPatch) => void;
  onKind: (kind: WorkflowStepKind) => void;
  onBranch: (branch: Record<string, string> | undefined) => void;
  onRemove: () => void;
}

function StepRow({
  id,
  step,
  stepIds,
  agents,
  extensions,
  onPatch,
  onKind,
  onBranch,
  onRemove
}: StepRowProps) {
  const branchEntries = step.branch ? Object.entries(step.branch) : [];
  const isTerminal = step.kind === "terminal";
  const hasParallel = Boolean(step.parallel);

  function addBranchRule(): void {
    const next: Record<string, string> = { ...(step.branch ?? {}) };
    next["passed"] = stepIds[0] ?? "";
    onBranch(next);
  }

  function setBranchTarget(event: string, target: string): void {
    const next: Record<string, string> = { ...(step.branch ?? {}) };
    if (target) next[event] = target;
    else delete next[event];
    onBranch(next);
  }

  return (
    <div class="wf-step">
      <div class="wf-step-head">
        <code class="wf-step-id">{id}</code>
        {hasParallel ? <span class="badge" data-tone="muted">parallel · edit in YAML</span> : null}
        {step.join ? <span class="badge" data-tone="muted">joins · edit in YAML</span> : null}
        <button class="btn btn-ghost wf-step-remove" type="button" onClick={onRemove} title="Remove step">
          <span dangerouslySetInnerHTML={{ __html: icon("trash", 14) }} />
        </button>
      </div>
      <div class="wf-grid-3">
        <label class="wf-field">
          <span>Kind</span>
          <select
            class="select"
            value={step.kind}
            onChange={(e) => onKind((e.currentTarget as HTMLSelectElement).value as WorkflowStepKind)}
          >
            {WORKFLOW_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {kindLabel(kind)}
              </option>
            ))}
          </select>
        </label>
        <label class="wf-field">
          <span>Agent</span>
          <select
            class="select"
            value={step.agent}
            onChange={(e) => onPatch({ agent: (e.currentTarget as HTMLSelectElement).value as WorkflowStepAgent })}
          >
            {STEP_AGENT_ROLES.map((role) => (
              <option key={role} value={role}>
                {role === "none" ? "None" : role === "author" ? "Author (default)" : "Reviewer (default)"}
              </option>
            ))}
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.displayName}
              </option>
            ))}
          </select>
        </label>
        <label class="wf-field">
          <span>Approval</span>
          <select
            class="select"
            value={step.approval}
            onChange={(e) => onPatch({ approval: (e.currentTarget as HTMLSelectElement).value as WorkflowStepApproval })}
          >
            {APPROVAL_OPTIONS.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
        </label>
        <label class="wf-field">
          <span>Effort</span>
          <select
            class="select"
            value={step.effort ?? ""}
            onChange={(e) => {
              const value = (e.currentTarget as HTMLSelectElement).value as EffortLevel | "";
              onPatch(value ? { effort: value } : { effort: undefined });
            }}
          >
            <option value="">(workflow default)</option>
            {EFFORT_OPTIONS.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
        </label>
        <label class="wf-field wf-field-wide">
          <span>Skill</span>
          <input
            class="input"
            type="text"
            value={step.skill ?? ""}
            placeholder="skill name"
            onInput={(e) => onPatch({ skill: (e.currentTarget as HTMLInputElement).value || undefined })}
          />
        </label>
      </div>

      <div class="wf-field wf-field-full">
        <ExtensionPicker
          selectedIds={step.extensions ?? []}
          extensions={extensions}
          onChange={(ids) => onPatch(ids ? { extensions: ids } : { extensions: undefined })}
        />
      </div>

      {!isTerminal && !hasParallel ? (
        <div class="wf-edges">
          <label class="wf-field wf-field-tight">
            <span>Next step</span>
            <select
              class="select"
              value={step.next ?? ""}
              onChange={(e) => {
                const value = (e.currentTarget as HTMLSelectElement).value;
                onPatch(value ? { next: value } : { next: undefined });
              }}
            >
              <option value="">(none)</option>
              {stepIds.map((target) => (
                <option key={target} value={target}>
                  {target}
                </option>
              ))}
            </select>
          </label>

          <div class="wf-branch">
            <div class="wf-branch-head">
              <span class="wf-field-label">Branch rules</span>
              <button class="btn btn-ghost" type="button" onClick={addBranchRule}>
                <span dangerouslySetInnerHTML={{ __html: icon("plus", 12) }} />
                <span>Add</span>
              </button>
            </div>
            {branchEntries.map(([event, target]) => (
              <div class="wf-branch-row" key={event}>
                <input
                  class="input wf-branch-event"
                  type="text"
                  value={event}
                  placeholder="event"
                  onInput={(e) => {
                    const renamed = (e.currentTarget as HTMLInputElement).value;
                    const current = step.branch?.[event] ?? "";
                    const next: Record<string, string> = { ...(step.branch ?? {}) };
                    delete next[event];
                    if (renamed) next[renamed] = current;
                    onBranch(next);
                  }}
                />
                <select
                  class="select"
                  value={target}
                  onChange={(e) => setBranchTarget(event, (e.currentTarget as HTMLSelectElement).value)}
                >
                  <option value="">(none)</option>
                  {stepIds.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

interface WorkflowSettingsProps {
  draft: WorkflowDefinition;
  setDraft: (next: WorkflowDefinition) => void;
  stepIds: string[];
  agents: AgentOption[];
  isNew: boolean;
}

function WorkflowSettings({ draft, setDraft, stepIds, agents, isNew }: WorkflowSettingsProps) {
  return (
    <div class="wf-settings">
      <div class="wf-grid-2">
        <label class="wf-field">
          <span>Name</span>
          <input
            class="input"
            type="text"
            value={draft.name}
            onInput={(e) => setDraft({ ...draft, name: (e.currentTarget as HTMLInputElement).value })}
          />
        </label>
        <label class="wf-field">
          <span>Identifier</span>
          <input
            class="input"
            type="text"
            value={draft.id}
            disabled={!isNew}
            onInput={(e) => setDraft({ ...draft, id: (e.currentTarget as HTMLInputElement).value })}
          />
        </label>
        <label class="wf-field">
          <span>Start step</span>
          <select
            class="select"
            value={draft.initial}
            onChange={(e) => setDraft({ ...draft, initial: (e.currentTarget as HTMLSelectElement).value })}
          >
            {stepIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div class="wf-grid-3">
        <label class="wf-field">
          <span>Author agent</span>
          <select
            class="select"
            value={draft.defaults.author}
            onChange={(e) =>
              setDraft({ ...draft, defaults: { ...draft.defaults, author: (e.currentTarget as HTMLSelectElement).value as WorkflowStepAgent } })
            }
          >
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.displayName}
              </option>
            ))}
          </select>
        </label>
        <label class="wf-field">
          <span>Reviewer agent</span>
          <select
            class="select"
            value={draft.defaults.reviewer}
            onChange={(e) =>
              setDraft({ ...draft, defaults: { ...draft.defaults, reviewer: (e.currentTarget as HTMLSelectElement).value as WorkflowStepAgent } })
            }
          >
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.displayName}
              </option>
            ))}
          </select>
        </label>
        <label class="wf-field">
          <span>Default effort</span>
          <select
            class="select"
            value={draft.defaults.effort ?? ""}
            onChange={(e) => {
              const value = (e.currentTarget as HTMLSelectElement).value as EffortLevel | "";
              const { effort: _omit, ...rest } = draft.defaults;
              void _omit;
              setDraft({ ...draft, defaults: value ? { ...rest, effort: value } : rest });
            }}
          >
            <option value="">(step default)</option>
            {EFFORT_OPTIONS.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}

const DRAFT_TASK = { id: "workflow-editor-draft" } as unknown as HarnessTask;

/** Project the editable definition into the WorkflowSummary shape the canvas expects. */
function defToSummary(def: WorkflowDefinition): WorkflowSummary {
  const steps: WorkflowSummary["steps"] = {};
  for (const [id, step] of Object.entries(def.steps)) {
    steps[id] = {
      kind: step.kind,
      agent: step.agent,
      approval: step.approval,
      ...(step.skill ? { skill: step.skill } : {}),
      ...(step.extensions ? { extensions: step.extensions } : {}),
      ...(step.effort ? { effort: step.effort } : {}),
      ...(step.next ? { next: step.next } : {}),
      ...(step.parallel ? { parallel: step.parallel } : {}),
      ...(step.join ? { join: step.join } : {}),
      ...(step.branch ? { branch: step.branch } : {})
    };
  }
  return {
    id: def.id,
    name: def.name,
    initial: def.initial,
    stepIds: Object.keys(def.steps),
    steps,
    defaults: def.defaults
  };
}
