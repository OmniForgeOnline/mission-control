import crypto from "node:crypto";
import path from "node:path";
import { execSync } from "node:child_process";
import { rm } from "node:fs/promises";

import { readJsonFile, writeJsonFile, ensureDir } from "../infra/fs.ts";
import { ensureHarnessRepository } from "../bootstrap/repository.ts";

export interface ProjectRecord {
  id: string;
  name: string;
  repoPath: string;
  status: "active" | "paused";
  createdAt: string;
  updatedAt: string;
  lastSeenAt?: string;
}

export interface OnboardProjectInput {
  repoPath: string;
  name?: string;
}

export interface UpdateProjectInput {
  name?: string;
  status?: "active" | "paused";
}

function projectsPath(root: string): string {
  return path.join(root, "data", "state", "projects.json");
}

export function projectDir(root: string, projectId: string): string {
  return path.join(root, "data", "state", "projects", projectId);
}

function now(): string {
  return new Date().toISOString();
}

function generateProjectId(normalizedPath: string): string {
  const hash = crypto.createHash("sha256").update(normalizedPath).digest("hex");
  return `proj-${hash.slice(0, 8)}`;
}

export function resolveGitTopLevel(repoPath: string): string | null {
  try {
    const result = execSync("git rev-parse --show-toplevel", {
      cwd: repoPath,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"]
    }).trim();
    return path.resolve(result);
  } catch {
    return null;
  }
}

async function readStoredProjects(root: string): Promise<ProjectRecord[]> {
  await ensureHarnessRepository(root);
  return readJsonFile<ProjectRecord[]>(projectsPath(root), []);
}

export async function listProjects(root: string): Promise<ProjectRecord[]> {
  return readStoredProjects(root);
}

export async function getProject(root: string, projectId: string): Promise<ProjectRecord | undefined> {
  const projects = await listProjects(root);
  return projects.find((p) => p.id === projectId);
}

function isNestedPath(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

export async function onboardProject(root: string, input: OnboardProjectInput): Promise<ProjectRecord> {
  const normalized = resolveGitTopLevel(input.repoPath);
  if (!normalized) {
    throw new Error(`Path does not resolve to a git worktree: ${input.repoPath}`);
  }

  // Also resolve the harness root for consistent comparison
  const projects = await readStoredProjects(root);

  const existing = projects.find((p) => p.repoPath === normalized);
  if (existing) {
    throw new Error(`Repo already registered as project "${existing.name}" (${existing.id}).`);
  }

  for (const p of projects) {
    if (isNestedPath(p.repoPath, normalized) || isNestedPath(normalized, p.repoPath)) {
      throw new Error(`Path is nested with existing project "${p.name}" (${p.repoPath}).`);
    }
  }

  const id = generateProjectId(normalized);
  const timestamp = now();
  const folderName = path.basename(normalized);
  const record: ProjectRecord = {
    id,
    name: input.name?.trim() || folderName,
    repoPath: normalized,
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp
  };

  const dir = projectDir(root, id);
  await ensureDir(dir);

  await writeJsonFile(projectsPath(root), [...projects, record]);
  return record;
}

export async function updateProject(root: string, projectId: string, input: UpdateProjectInput): Promise<ProjectRecord> {
  const projects = await readStoredProjects(root);
  const index = projects.findIndex((p) => p.id === projectId);
  if (index === -1) {
    throw new Error(`Project not found: ${projectId}`);
  }
  const current = projects[index]!;
  projects[index] = {
    ...current,
    ...(input.name !== undefined ? { name: input.name.trim() || current.name } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    updatedAt: now()
  };
  await writeJsonFile(projectsPath(root), projects);
  return projects[index]!;
}

export async function removeProject(root: string, projectId: string): Promise<void> {
  const projects = await readStoredProjects(root);
  const remaining = projects.filter((p) => p.id !== projectId);
  if (remaining.length === projects.length) {
    throw new Error(`Project not found: ${projectId}`);
  }
  await writeJsonFile(projectsPath(root), remaining);
  const dir = projectDir(root, projectId);
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
