import crypto from "node:crypto";
import path from "node:path";

import { readJsonFile, writeJsonFile } from "../infra/fs.ts";

export type OperationalErrorStatus = "open" | "triaged" | "dismissed";
export type BlockedReasonScope = "task_scoped" | "harness_platform" | "ignored";

const TASK_SCOPED_PATTERNS: RegExp[] = [
  /pre-commit/i,
  /autofix/i,
  /eslint/i,
  /@typescript-eslint/i,
  /mechanical checks/i,
  /harness commit/i,
  /command failed:\s*git commit/i,
  /\blint\b/i,
  /unused (?:var|import|exports?)/i,
  /npm (?:run )?test/i,
  /vitest/i,
  /\bturn failed\b/i,
  /no-unused-vars/i
];

const HARNESS_PLATFORM_PATTERNS: RegExp[] = [
  /exceeded maximum resume attempts/i,
  /merge request creation failed/i,
  /create merge request requires/i,
  /harness went down/i,
  /failed to start \w+:/i,
  /reviewer returned unclear verdict/i
];

export interface OperationalErrorCapture {
  message: string;
  taskId?: string;
  taskTitle?: string;
  taskSource?: string;
  runId?: string;
  workflowStep?: string;
}

export interface OperationalError extends OperationalErrorCapture {
  id: string;
  fingerprint: string;
  capturedAt: string;
  status: OperationalErrorStatus;
  triagedAt?: string;
}

const MAX_LEDGER_ENTRIES = 200;
const DEDUP_WINDOW_MS = 6 * 60 * 60 * 1000;

export function operationalErrorsPath(root: string): string {
  return path.join(root, "data", "state", "operational-errors.json");
}

function normalizeMessage(message: string): string {
  return message
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
    .replace(/harness\/[a-z0-9_-]+/gi, "harness/<branch>")
    .replace(/harness\([a-z0-9_-]+\)/gi, "harness(<id>)")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2000);
}

export function fingerprintOperationalError(input: OperationalErrorCapture): string {
  const parts = [
    normalizeMessage(input.message),
    input.workflowStep ?? "",
    input.taskTitle ?? ""
  ];
  return crypto.createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16);
}

/** Classify why a task blocked. Only `harness_platform` belongs in the operational-error ledger. */
export function classifyBlockedReason(message: string): BlockedReasonScope {
  const trimmed = message.trim();
  if (!trimmed) return "ignored";
  const lower = trimmed.toLowerCase();
  if (lower.includes("stopped by operator") || lower.includes("stopped by user")) return "ignored";
  if (HARNESS_PLATFORM_PATTERNS.some((pattern) => pattern.test(trimmed))) return "harness_platform";
  if (TASK_SCOPED_PATTERNS.some((pattern) => pattern.test(trimmed))) return "task_scoped";
  return "ignored";
}

export function shouldCaptureOperationalError(input: OperationalErrorCapture): boolean {
  const message = input.message.trim();
  if (!message) return false;
  if (input.taskId?.startsWith("autonomy:")) return false;
  if (input.taskSource === "autonomy") return false;
  return classifyBlockedReason(message) === "harness_platform";
}

export async function listOperationalErrors(root: string): Promise<OperationalError[]> {
  return readJsonFile<OperationalError[]>(operationalErrorsPath(root), []);
}

export async function listOpenOperationalErrors(root: string, limit = 12): Promise<OperationalError[]> {
  const items = await listOperationalErrors(root);
  return items.filter((item) => item.status === "open").slice(0, limit);
}

export async function captureOperationalError(
  root: string,
  input: OperationalErrorCapture
): Promise<OperationalError | null> {
  if (!shouldCaptureOperationalError(input)) return null;

  const fingerprint = fingerprintOperationalError(input);
  const items = await listOperationalErrors(root);
  const now = Date.now();
  const duplicate = items.find(
    (item) =>
      item.fingerprint === fingerprint &&
      item.status === "open" &&
      now - Date.parse(item.capturedAt) < DEDUP_WINDOW_MS
  );
  if (duplicate) return duplicate;

  const entry: OperationalError = {
    id: crypto.randomUUID(),
    fingerprint,
    capturedAt: new Date().toISOString(),
    status: "open",
    message: input.message.trim(),
    ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
    ...(input.taskTitle !== undefined ? { taskTitle: input.taskTitle } : {}),
    ...(input.taskSource !== undefined ? { taskSource: input.taskSource } : {}),
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
    ...(input.workflowStep !== undefined ? { workflowStep: input.workflowStep } : {})
  };

  await writeJsonFile(operationalErrorsPath(root), [entry, ...items].slice(0, MAX_LEDGER_ENTRIES));
  return entry;
}

export async function markOperationalErrorsTriaged(root: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const idSet = new Set(ids);
  const items = await listOperationalErrors(root);
  const triagedAt = new Date().toISOString();
  const next = items.map((item) =>
    idSet.has(item.id) ? { ...item, status: "triaged" as const, triagedAt } : item
  );
  await writeJsonFile(operationalErrorsPath(root), next);
}