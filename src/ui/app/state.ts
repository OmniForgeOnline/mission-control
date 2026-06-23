import type { TaskFilter } from "@ui/features/tasks/filters.js";
import { taskIsRunning } from "./task-status.js";
import type { AppState, HarnessRun, HarnessTask, WorkflowSummary } from "./types.js";

export type ViewName =
  | "home"
  | "project"
  | "tasks"
  | "task"
  | "skills"
  | "connectors"
  | "workflows"
  | "maintenance"
  | "settings";

const VIEW_NAMES = new Set<ViewName>([
  "home",
  "project",
  "tasks",
  "task",
  "skills",
  "connectors",
  "workflows",
  "maintenance",
  "settings"
]);

/** Tabs surfaced inside a project detail view. */
export type ProjectTab = "overview" | "runs" | "autonomy" | "memory" | "quality";

const PROJECT_TABS = new Set<ProjectTab>(["overview", "runs", "autonomy", "memory", "quality"]);

export function parseProjectTab(value: string | undefined): ProjectTab {
  if (value && PROJECT_TABS.has(value as ProjectTab)) return value as ProjectTab;
  return "overview";
}

export function isViewName(value: string): value is ViewName {
  return VIEW_NAMES.has(value as ViewName);
}

export function parseViewName(value: string | undefined): ViewName {
  if (value && isViewName(value)) return value;
  return "home";
}

export interface UIState {
  view: ViewName;
  taskId: string | null;
  projectTab: ProjectTab;
  data: AppState | null;
  selectedTaskIds: Set<string>;
  tasksFilter: TaskFilter;
  referringView: ViewName | null;
  referringTasksFilter: TaskFilter | null;
  theme: "dark" | "light";
}

export const ui: UIState = {
  view: "home",
  taskId: null,
  projectTab: "overview",
  data: null,
  selectedTaskIds: new Set(),
  tasksFilter: "all",
  referringView: null,
  referringTasksFilter: null,
  theme: readStoredTheme()
};

function readStoredTheme(): "dark" | "light" {
  try {
    return (localStorage.getItem("harness:theme") as "dark" | "light") ?? "dark";
  } catch {
    return "dark";
  }
}

try {
  document.documentElement.setAttribute("data-theme", ui.theme);
} catch {
  // Test / non-DOM environments
}

export function setTheme(theme: "dark" | "light"): void {
  ui.theme = theme;
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("harness:theme", theme);
}

export function findTask(id: string | null): HarnessTask | undefined {
  if (!id) return undefined;
  return ui.data?.tasks.find((t) => t.id === id);
}

export function workflowForTask(task: HarnessTask): WorkflowSummary | undefined {
  const workflowId = task.workflowRun?.workflowId;
  if (!workflowId) return ui.data?.workflows?.[0];
  return ui.data?.workflows?.find((w) => w.id === workflowId) ?? ui.data?.workflows?.[0];
}

export function defaultHarnessAgent(): string {
  return ui.data?.settings?.defaultAgent ?? "grok";
}

function agentSummary(agent: string) {
  return ui.data?.agents?.find((entry) => entry.id === agent);
}

export function agentSupportsEffort(agent: string): boolean {
  return agentSummary(agent)?.supportsEffort ?? false;
}

export function effortLevelsForAgent(agent: string): string[] {
  return agentSummary(agent)?.effortLevels ?? [];
}

function resolvedStepEffort(task: HarnessTask, stepId?: string): string | null {
  const stage = stepId ?? task.workflowRun?.currentStepId;
  if (!stage) return null;
  const summary = workflowForTask(task);
  const step = summary?.steps[stage];
  if (!step || step.agent === "none") return null;
  return step.effort ?? summary?.defaults.effort ?? null;
}

export function effectiveTaskEffort(task: HarnessTask, stepId?: string): string | null {
  const stageOverride = stepId ? task.stageEffortOverrides?.[stepId] : undefined;
  return stageOverride ?? task.effort ?? resolvedStepEffort(task, stepId);
}

function workflowStepAgentWithoutOverrides(task: HarnessTask, stage: string): string | null {
  const summary = workflowForTask(task);
  const step = summary?.steps[stage];
  if (!step || step.agent === "none") return null;

  const agent = step.agent;
  if (agent === "author") {
    return summary?.defaults.author ?? defaultHarnessAgent();
  }
  if (agent === "reviewer") {
    return summary?.defaults.reviewer ?? defaultHarnessAgent();
  }
  return agent;
}

export function workflowStepAgent(task: HarnessTask, stepId?: string): string | null {
  const stage = stepId ?? task.workflowRun?.currentStepId;
  if (!stage) return null;
  return workflowStepAgentWithoutOverrides(task, stage);
}

export function preferredStepAgent(task: HarnessTask, stepId?: string): string | null {
  const stage = stepId ?? task.workflowRun?.currentStepId;
  if (!stage) return null;
  const taskOverride = task.stageAgentOverrides?.[stage];
  if (taskOverride) return taskOverride;
  const override = ui.data?.stageAgentOverrides?.[stage];
  if (override) return override;
  return workflowStepAgentWithoutOverrides(task, stage);
}

export function resolvedStepAgent(task: HarnessTask, stepId?: string): string | null {
  return preferredStepAgent(task, stepId);
}

export function stepAgentCapacityNote(_task: HarnessTask, _stepId?: string): string | null {
  return null;
}

export interface ModelPoolOption {
  id: string;
  displayName: string;
}

/**
 * Resolve a model pool id to its display name. Falls back to the raw id when the
 * pool is no longer configured (e.g. historical runs captured before this field
 * existed) and returns null when no model was recorded.
 */
export function modelPoolDisplayName(
  modelPoolId: string | undefined,
  pools: readonly ModelPoolOption[] = ui.data?.agentConfig?.pools ?? []
): string | null {
  if (!modelPoolId) return null;
  return pools.find((pool) => pool.id === modelPoolId)?.displayName ?? modelPoolId;
}

/**
 * Model pool id recorded on the task's active run — the turn currently executing
 * the current step. Undefined when no run is active or the run predates capture.
 */
export function activeRunModelPoolId(task: HarnessTask): string | undefined {
  if (!task.runId) return undefined;
  return ui.data?.runs?.find((run) => run.id === task.runId)?.modelPoolId;
}

/** Whether `stepId` is the step the workflow is currently executing. */
export function isStepActive(task: HarnessTask, stepId: string): boolean {
  return (
    task.workflowRun?.currentStepId === stepId
    || Boolean(task.workflowRun?.activeStepIds?.includes(stepId))
  );
}

/**
 * Model pool id that drove the run for `stepId`. Prefers the newest run stamped
 * with this step (so completed steps surface their own model after the workflow
 * advances); falls back to the task's active run only for the executing step,
 * covering runs that predate step capture. Undefined otherwise, so a completed
 * step is never mislabeled with the current step's model.
 */
export function stepRunModelPoolId(
  task: HarnessTask,
  stepId: string,
  runs: readonly HarnessRun[] = ui.data?.runs ?? []
): string | undefined {
  const taskRuns = runs.filter((run) => run.taskId === task.id);
  const forStep = taskRuns.filter((run) => run.stepId === stepId);
  if (forStep.length > 0) {
    return forStep.reduce((latest, run) =>
      run.startedAt > latest.startedAt ? run : latest
    ).modelPoolId;
  }
  if (isStepActive(task, stepId) && task.runId) {
    return taskRuns.find((run) => run.id === task.runId)?.modelPoolId;
  }
  return undefined;
}

export function relativeTime(iso?: string): string {
  if (!iso) return "—";
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return "—";
  if (ms < 60_000) return "just now";
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ago`;
  if (h > 0) return `${h}h ago`;
  return `${m}m ago`;
}

function sinceLabel(iso?: string): string {
  if (!iso) return "—";
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return "—";
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
}

function elapsedLabel(iso?: string): string {
  if (!iso) return "—";
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  if (m < 1) return `${s}s`;
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export type LivenessLevel = "active" | "stale" | "long";

export interface Liveness {
  level: LivenessLevel;
  text: string;
  warn: boolean;
}

export function liveness(task: HarnessTask): Liveness | null {
  if (!taskIsRunning(task)) return null;
  const staleMs = ui.data?.activityThresholds?.staleMs ?? 4 * 60_000;
  const longRunMs = ui.data?.activityThresholds?.longRunMs ?? 20 * 60_000;
  const activity = task.currentActivity ?? "working";
  const lastBeat = task.lastProgressAt ?? task.startedAt;
  const sinceBeat = lastBeat ? Date.now() - Date.parse(lastBeat) : 0;
  const sinceStart = task.startedAt ? Date.now() - Date.parse(task.startedAt) : 0;

  if (sinceBeat >= staleMs) {
    return {
      level: "stale",
      warn: true,
      text: `No activity for ${elapsedLabel(lastBeat)} — last: ${activity}`
    };
  }
  if (sinceStart >= longRunMs) {
    return {
      level: "long",
      warn: true,
      text: `${activity} · running ${elapsedLabel(task.startedAt)}`
    };
  }
  return {
    level: "active",
    warn: false,
    text: `${activity} · active ${sinceLabel(lastBeat)}`
  };
}
