import { useEffect, useState } from "preact/hooks";
import type { AgentConfigBundle } from "../../../../core/agents/config/types.ts";
import { api } from "@ui/data/api.js";
import { ui } from "@ui/app/state.js";
import { toast } from "@ui/overlays/toast.js";

function refresh(): void {
  document.dispatchEvent(new CustomEvent("harness:refresh"));
}

function stepLabel(id: string): string {
  return id.replace(/_/g, " ");
}

export function WorkflowDefaults({ config }: { config: AgentConfigBundle }) {
  const workflows = ui.data?.workflows ?? [];
  const [workflowId, setWorkflowId] = useState(workflows[0]?.id ?? "");
  const workflow = workflows.find((entry) => entry.id === workflowId) ?? workflows[0];
  const steps = workflow
    ? Object.entries(workflow.steps).filter(([, step]) => step.agent !== "none")
    : [];
  const [stepId, setStepId] = useState(steps[0]?.[0] ?? "");
  const selectedKey = workflow && stepId ? `${workflow.id}:${stepId}` : "";
  const selectedStep = workflow?.steps[stepId];
  const selectedAgent = selectedKey ? ui.data?.stageAgentOverrides?.[selectedKey] ?? "" : "";
  const selectedPool = selectedKey ? ui.data?.stageModelPoolOverrides?.[selectedKey] ?? "" : "";
  const ambiguousAgents = ui.data?.ambiguousStageAgentOverrides ?? {};
  const ambiguousPools = ui.data?.ambiguousStageModelPoolOverrides ?? {};
  const effectiveAgent = selectedAgent || (selectedStep?.agent === "author"
    ? workflow?.defaults.author
    : selectedStep?.agent === "reviewer"
      ? workflow?.defaults.reviewer
      : selectedStep?.agent);
  const capability = selectedStep?.agent === "reviewer" || selectedStep?.kind === "review" ? "reviewer" : "author";
  const pools = config.pools.filter((pool) =>
    pool.id === selectedPool || (pool.enabled && pool.toolId === effectiveAgent && pool.capabilities.includes(capability))
  );

  useEffect(() => {
    if (!workflows.some((entry) => entry.id === workflowId)) setWorkflowId(workflows[0]?.id ?? "");
  }, [workflows, workflowId]);

  useEffect(() => {
    if (!steps.some(([id]) => id === stepId)) setStepId(steps[0]?.[0] ?? "");
  }, [stepId, workflowId]);

  async function save(poolId: string): Promise<void> {
    if (!workflow || !stepId) return;
    try {
      await api(`/api/settings/stage-model-pools/${encodeURIComponent(stepId)}`, {
        method: "POST",
        body: JSON.stringify({ workflowId: workflow.id, poolId })
      });
      toast("Workflow model default saved.", { tone: "success" });
      refresh();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not save workflow model default.", { tone: "error" });
    }
  }

  async function saveAgent(agent: string): Promise<void> {
    if (!workflow || !stepId) return;
    try {
      await api(`/api/settings/stage-agents/${encodeURIComponent(stepId)}`, {
        method: "POST",
        body: JSON.stringify({ workflowId: workflow.id, agent })
      });
      toast("Workflow agent default saved.", { tone: "success" });
      refresh();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not save workflow agent default.", { tone: "error" });
    }
  }

  async function clear(): Promise<void> {
    if (!workflow || !stepId) return;
    try {
      await api(`/api/settings/stage-model-pools/${encodeURIComponent(stepId)}?workflowId=${encodeURIComponent(workflow.id)}`, {
        method: "DELETE"
      });
      toast("Workflow model default cleared.", { tone: "success" });
      refresh();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not clear workflow model default.", { tone: "error" });
    }
  }

  async function clearAgent(): Promise<void> {
    if (!workflow || !stepId) return;
    try {
      await api(`/api/settings/stage-agents/${encodeURIComponent(stepId)}?workflowId=${encodeURIComponent(workflow.id)}`, {
        method: "DELETE"
      });
      toast("Workflow agent default cleared.", { tone: "success" });
      refresh();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not clear workflow agent default.", { tone: "error" });
    }
  }

  async function adopt(step: string, targetWorkflowId: string): Promise<void> {
    try {
      await api(`/api/settings/stage-model-pools/${encodeURIComponent(step)}/adopt-legacy`, {
        method: "POST",
        body: JSON.stringify({ workflowId: targetWorkflowId })
      });
      toast(`Adopted legacy default for ${targetWorkflowId}.`, { tone: "success" });
      refresh();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not adopt legacy model default.", { tone: "error" });
    }
  }

  async function adoptAgent(step: string, targetWorkflowId: string): Promise<void> {
    try {
      await api(`/api/settings/stage-agents/${encodeURIComponent(step)}/adopt-legacy`, {
        method: "POST",
        body: JSON.stringify({ workflowId: targetWorkflowId })
      });
      toast(`Adopted legacy agent default for ${targetWorkflowId}.`, { tone: "success" });
      refresh();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not adopt legacy agent default.", { tone: "error" });
    }
  }

  if (!workflow) return null;

  return (
    <section class="settings-section" data-settings-panel="workflow-defaults">
      <div class="catalog-section-label">Workflow defaults</div>
      <p class="settings-note">Choose persistent agent and model defaults for each workflow step. Task overrides remain separate.</p>
      <div class="settings-row">
        <div class="settings-row-copy">
          <div class="settings-row-label">Workflow step</div>
          <div class="settings-row-desc">Validated against the selected workflow and agent capability.</div>
        </div>
        <div class="settings-row-control">
          <select class="select settings-control" value={workflow.id} onChange={(event) => setWorkflowId(event.currentTarget.value)}>
            {workflows.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
          </select>
          <select class="select settings-control" value={stepId} onChange={(event) => setStepId(event.currentTarget.value)}>
            {steps.map(([id]) => <option key={id} value={id}>{stepLabel(id)}</option>)}
          </select>
        </div>
      </div>
      <div class="settings-row">
        <div class="settings-row-copy">
          <div class="settings-row-label">Agent default</div>
          <div class="settings-row-desc">The tool assigned to this workflow step.</div>
        </div>
        <div class="settings-row-control">
          <select class="select settings-control" value={selectedAgent} onChange={(event) => void (event.currentTarget.value ? saveAgent(event.currentTarget.value) : clearAgent())}>
            <option value="">Workflow default</option>
            {config.tools.map((tool) => <option key={tool.id} value={tool.id} disabled={!tool.enabled}>{tool.displayName} ({tool.id})</option>)}
          </select>
          <button class="btn btn-sm btn-ghost" type="button" disabled={!selectedAgent} onClick={() => void clearAgent()}>Clear</button>
        </div>
      </div>
      <div class="settings-row">
        <div class="settings-row-copy">
          <div class="settings-row-label">Model default</div>
          <div class="settings-row-desc">Only enabled pools compatible with the resolved agent and role.</div>
        </div>
        <div class="settings-row-control">
          <select class="select settings-control" value={selectedPool} onChange={(event) => void (event.currentTarget.value ? save(event.currentTarget.value) : clear())}>
            <option value="">No override</option>
            {pools.map((pool) => <option key={pool.id} value={pool.id} disabled={!pool.enabled || pool.toolId !== effectiveAgent || !pool.capabilities.includes(capability)}>{pool.displayName} ({pool.id})</option>)}
          </select>
          <button class="btn btn-sm btn-ghost" type="button" disabled={!selectedPool} onClick={() => void clear()}>Clear</button>
        </div>
      </div>
      {Object.entries(ambiguousAgents).map(([step, agent]) => (
        <div class="settings-row" key={`agent:${step}`}>
          <div class="settings-row-copy">
            <div class="settings-row-label">Legacy step-only agent: {step}</div>
            <div class="settings-row-desc">{agent} needs a workflow choice before it can be adopted.</div>
          </div>
          <div class="settings-row-control">
            {workflows.filter((entry) => step in entry.steps).map((entry) => (
              <button class="btn btn-sm" type="button" key={entry.id} onClick={() => void adoptAgent(step, entry.id)}>Adopt for {entry.name}</button>
            ))}
          </div>
        </div>
      ))}
      {Object.entries(ambiguousPools).map(([step, poolId]) => (
        <div class="settings-row" key={`pool:${step}`}>
          <div class="settings-row-copy">
            <div class="settings-row-label">Legacy step-only default: {step}</div>
            <div class="settings-row-desc">{poolId} needs a workflow choice before it can be validated and adopted.</div>
          </div>
          <div class="settings-row-control">
            {workflows.filter((entry) => step in entry.steps).map((entry) => (
              <button class="btn btn-sm" type="button" key={entry.id} onClick={() => void adopt(step, entry.id)}>Adopt for {entry.name}</button>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}
