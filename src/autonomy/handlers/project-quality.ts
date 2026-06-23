import path from "node:path";

import { computeProjectQualityGrades } from "../../core/quality/quality.ts";
import { approveTask, createTask, listTasks } from "../../core/tasks/tasks.ts";
import { projectDir } from "../../core/projects/registry.ts";
import type { AutonomyJobContext } from "../registry.ts";
import type { AutonomyRunResult } from "../job-types.ts";
import { readJsonFile, writeJsonFile } from "../../core/infra/fs.ts";
import { buildQualityGateRemediation, domainsBelowGrade, qualityGateTaskTitle } from "../../core/quality/quality.ts";
import type { QualityFile } from "../../core/quality/quality.ts";

export async function runProjectQualityGradeUpdate(
  root: string,
  context?: AutonomyJobContext
): Promise<AutonomyRunResult> {
  const project = context?.project;
  if (!project) throw new Error("Missing project context.");
  const result = await computeProjectQualityGrades(root, project.repoPath);
  const filePath = path.join(projectDir(root, project.id), "quality.json");
  await writeJsonFile(filePath, result);

  if (result.skipped) {
    return {
      jobId: "quality-grade-update",
      status: "completed",
      summary: `Skipped: ${result.reason}`,
      proposalsCreated: 0
    };
  }
  const count = Object.keys(result.domains).length;
  return {
    jobId: "quality-grade-update",
    status: "completed",
    summary: `Updated quality grades for ${count} domain(s) in ${project.name}.`,
    proposalsCreated: 0
  };
}

export async function runProjectQualityGateSweep(
  root: string,
  context?: AutonomyJobContext
): Promise<AutonomyRunResult> {
  const project = context?.project;
  if (!project) throw new Error("Missing project context.");

  const filePath = path.join(projectDir(root, project.id), "quality.json");
  const quality = await readJsonFile<QualityFile>(filePath, { updatedAt: "", domains: {} });
  const belowA = domainsBelowGrade(quality, "A");
  if (!belowA.length) {
    return {
      jobId: "quality-gate-sweep",
      status: "completed",
      summary: `All domains are grade A in ${project.name}.`,
      proposalsCreated: 0
    };
  }

  const tasks = await listTasks(root);
  const targets = belowA.filter((candidate) => {
    const title = qualityGateTaskTitle(candidate.domain);
    return !tasks.some((t) => t.title === title && !t.resolution && t.targets.some((tgt) => tgt.path.startsWith(project.repoPath)));
  });

  if (!targets.length) {
    return {
      jobId: "quality-gate-sweep",
      status: "completed",
      summary: `${belowA.length} domain(s) below grade A in ${project.name} already have active tasks.`,
      proposalsCreated: 0
    };
  }

  const createdIds: string[] = [];
  const summaries: string[] = [];
  for (const target of targets) {
    const evidence = target.entry.evidence.length ? target.entry.evidence[0]! : target.domain;
    const remediation = buildQualityGateRemediation(target.domain, target.entry);
    const created = await createTask(root, {
      title: remediation.title,
      description: remediation.description,
      agent: "claude",
      source: "autonomy",
      links: [],
      projectId: project.id,
      repoPath: project.repoPath,
      targets: [{ raw: `@${evidence}`, path: evidence, kind: "directory" }]
    });
    await approveTask(root, created.id);
    createdIds.push(created.id);
    summaries.push(`${target.domain} (grade ${target.entry.grade})`);
  }

  const countLabel = summaries.length === 1 ? "1 domain" : `${summaries.length} domains`;
  return {
    jobId: "quality-gate-sweep",
    status: "completed",
    summary: `Quality-gate sweep for ${project.name}: ${countLabel} below grade A: ${summaries.join(", ")}.`,
    proposalsCreated: 0,
    ...(createdIds[0] !== undefined ? { syntheticTaskId: createdIds[0] } : {})
  };
}
