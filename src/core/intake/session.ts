import crypto from "node:crypto";
import path from "node:path";

import { ensureHarnessRepository } from "../bootstrap/repository.ts";
import { ensureDir, readJsonFile, writeJsonFile } from "../infra/fs.ts";
import { emitStateChange } from "../infra/state-bus.ts";
import { loadHarnessSettings } from "../settings.ts";
import type { HarnessMessage, IntakeScope, IntakeSession } from "../types.ts";

export const GLOBAL_INTAKE_SCOPE: IntakeScope = { kind: "global" };

const intakeSessionLocks = new Map<string, Promise<void>>();

function now(): string {
  return new Date().toISOString();
}

export function normalizeIntakeScope(scope?: IntakeScope): IntakeScope {
  if (scope?.kind === "project") return scope;
  return GLOBAL_INTAKE_SCOPE;
}

export function intakeScopeKey(scope?: IntakeScope): string {
  const normalized = normalizeIntakeScope(scope);
  return normalized.kind === "project" ? `project:${normalized.projectId}` : "global";
}

function intakeSessionFileName(scope?: IntakeScope): string {
  const normalized = normalizeIntakeScope(scope);
  return normalized.kind === "project" ? `project-${normalized.projectId}.json` : "global.json";
}

function intakeSessionsDir(root: string): string {
  return path.join(root, "data", "state", "intake-sessions");
}

export function scopedIntakePath(root: string, scope?: IntakeScope): string {
  return path.join(intakeSessionsDir(root), intakeSessionFileName(scope));
}

function legacyIntakePath(root: string): string {
  return path.join(root, "data", "state", "intake-session.json");
}

export function makeIntakeMessage(
  author: HarnessMessage["author"],
  body: string
): HarnessMessage {
  return {
    id: crypto.randomUUID(),
    author,
    body: body.trim(),
    createdAt: now()
  };
}

export async function emptyIntakeSession(root: string, scope?: IntakeScope): Promise<IntakeSession> {
  const settings = await loadHarnessSettings(root);
  const timestamp = now();
  return {
    id: crypto.randomUUID(),
    agent: settings.defaultAgent,
    status: "active",
    scope: normalizeIntakeScope(scope),
    messages: [],
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function withScope(session: IntakeSession, scope?: IntakeScope): IntakeSession {
  return {
    ...session,
    scope: session.scope ?? normalizeIntakeScope(scope)
  };
}

export async function readIntakeSessionFile(root: string, scope?: IntakeScope): Promise<IntakeSession | null> {
  await ensureHarnessRepository(root);
  const normalized = normalizeIntakeScope(scope);
  const scoped = await readJsonFile<IntakeSession | null>(scopedIntakePath(root, normalized), null);
  if (scoped) return withScope(scoped, normalized);
  if (normalized.kind === "global") {
    const legacy = await readJsonFile<IntakeSession | null>(legacyIntakePath(root), null);
    if (legacy) return withScope(legacy, normalized);
  }
  return null;
}

export async function writeIntakeSessionFile(root: string, session: IntakeSession): Promise<IntakeSession> {
  const scoped = withScope(session, session.scope);
  await ensureDir(intakeSessionsDir(root));
  await writeJsonFile(scopedIntakePath(root, scoped.scope), scoped);
  emitStateChange(["chrome", "intake"]);
  return scoped;
}

export async function withIntakeSessionLock<T>(
  root: string,
  scope: IntakeScope | undefined,
  action: () => Promise<T>
): Promise<T> {
  const key = `${root}:${intakeScopeKey(scope)}`;
  const previous = intakeSessionLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const current = previous.catch(() => {}).then(() => gate);
  intakeSessionLocks.set(key, current);
  await previous.catch(() => {});
  try {
    return await action();
  } finally {
    release();
    if (intakeSessionLocks.get(key) === current) {
      intakeSessionLocks.delete(key);
    }
  }
}

export async function updateIntakeSessionFile(
  root: string,
  scope: IntakeScope | undefined,
  hydrate: (session: IntakeSession) => Promise<IntakeSession>,
  updater: (session: IntakeSession) => IntakeSession
): Promise<IntakeSession> {
  const normalized = normalizeIntakeScope(scope);
  return withIntakeSessionLock(root, normalized, async () => {
    const existing = await readIntakeSessionFile(root, normalized);
    const session = existing && existing.status === "active"
      ? await hydrate(existing)
      : await emptyIntakeSession(root, normalized);
    return writeIntakeSessionFile(root, updater(session));
  });
}

export function touchIntakeSession(session: IntakeSession): IntakeSession {
  return { ...session, updatedAt: now() };
}

export function intakeTimestamp(): string {
  return now();
}
