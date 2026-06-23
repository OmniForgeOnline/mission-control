export interface RawEvent {
  type?: string;
  subtype?: string;
  message?: { content?: ContentItem[] };
  hook_name?: string;
  attempt?: number;
  max_retries?: number;
  model?: string;
  cwd?: string;
  description?: string;
  subagent_type?: string;
  text?: string;
  [key: string]: unknown;
}

export interface ContentItem {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: unknown;
  is_error?: boolean;
}

export type Tone = "default" | "muted" | "accent" | "warn" | "error" | "ok";

export interface Row {
  id: string;
  ico: string;
  kind: string;
  title: string;
  body?: string;
  detail?: string;
  tone: Tone;
}

export type TailStatus = "active" | "complete" | "error";

export interface TailInstance {
  runId: string;
  title: string;
  host: HTMLElement | null;
  timer: number | null;
  offset: number;
  buffer: string;
  events: RawEvent[];
  expanded: Set<string>;
  stick: boolean;
  renderedRows: number;
  status: TailStatus;
  errorMessage: string | null;
  pollFailures: number;
}

const instances = new Map<string, TailInstance>();

export function getTail(runId: string): TailInstance | undefined {
  return instances.get(runId);
}

export function getOrCreateTail(
  runId: string,
  title: string,
  host: HTMLElement | null
): TailInstance {
  const existing = instances.get(runId);
  if (existing) {
    existing.title = title;
    existing.host = host;
    return existing;
  }
  const created: TailInstance = {
    runId,
    title,
    host,
    timer: null,
    offset: 0,
    buffer: "",
    events: [],
    expanded: new Set(),
    stick: true,
    renderedRows: 0,
    status: "active",
    errorMessage: null,
    pollFailures: 0
  };
  instances.set(runId, created);
  return created;
}

export function allTails(): TailInstance[] {
  return [...instances.values()];
}

export function removeTail(runId: string): void {
  instances.delete(runId);
}

export function setStickFor(runId: string, value: boolean): void {
  const inst = getTail(runId);
  if (inst) inst.stick = value;
}

