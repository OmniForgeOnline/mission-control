import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { readJsonFile, writeJsonFile } from "../infra/fs.ts";
import { walkDir } from "../infra/walk-dir.ts";

export type QualityGrade = "A" | "B" | "C" | "D" | "F";

const QUALITY_GATE_TASK_PREFIX = "Quality gate:";

/** A source file is "oversized" above this many lines (aligned with the AGENTS.md 500-line norm). */
const OVERSIZE_LINE_THRESHOLD = 500;
const ESTIMATED_BYTES_PER_LINE = 80;

const GRADE_RANK: Record<QualityGrade, number> = {
  A: 5,
  B: 4,
  C: 3,
  D: 2,
  F: 1
};

function compareQualityGrades(a: QualityGrade, b: QualityGrade): number {
  return GRADE_RANK[a] - GRADE_RANK[b];
}

export function qualityGateTaskTitle(domain: string): string {
  return `${QUALITY_GATE_TASK_PREFIX} ${domain}`;
}

export function buildQualityGateRemediation(
  domain: string,
  entry: Pick<DomainQuality, "grade" | "rationale" | "evidence">
): { title: string; description: string } {
  const title = qualityGateTaskTitle(domain);
  const evidence = entry.evidence.length ? entry.evidence.join(", ") : `src/${domain}`;
  const lines = [
    `The \`${domain}\` domain currently has quality grade **${entry.grade}**.`,
    "",
    `Rationale: ${entry.rationale}`,
    "",
    "Bring this domain to grade A by addressing the issues above. Typical fixes:",
    "- Add or extend tests under `tests/` that reference this domain when tests are missing.",
    "- Split or refactor oversized source files when the grade cites them.",
    "",
    `Scope: ${evidence}`,
    "",
    "After your changes, the autonomy `quality-gate-sweep` job will recompute grades on the next run."
  ];
  return { title, description: lines.join("\n") };
}

export function domainsBelowGrade(
  quality: QualityFile,
  targetGrade: QualityGrade = "A"
): Array<{ domain: string; entry: DomainQuality }> {
  const targetRank = GRADE_RANK[targetGrade];
  return Object.entries(quality.domains ?? {})
    .filter(([, entry]) => GRADE_RANK[entry.grade] < targetRank)
    .map(([domain, entry]) => ({ domain, entry }))
    .sort((a, b) => compareQualityGrades(a.entry.grade, b.entry.grade));
}

export interface DomainQuality {
  grade: QualityGrade;
  rationale: string;
  evidence: string[];
  lastComputedAt: string;
}

export interface QualityFile {
  updatedAt: string;
  domains: Record<string, DomainQuality>;
}

function qualityPath(root: string): string {
  return path.join(root, "data", "state", "quality.json");
}

async function discoverDomains(root: string): Promise<string[]> {
  const srcDir = path.join(root, "src");
  try {
    const entries = await readdir(srcDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

async function fileSize(filePath: string): Promise<number> {
  try {
    const info = await stat(filePath);
    return info.size;
  } catch {
    return 0;
  }
}

interface DomainStats {
  files: number;
  bytes: number;
  oversized: string[];
  hasTests: boolean;
}

async function statsForDomainFromDir(
  codeDir: string,
  testRoot: string,
  domainName: string
): Promise<DomainStats> {
  const files = await walkDir(codeDir, {
    fileFilter: (entry) => /\.(ts|tsx|js|jsx)$/.test(entry.name)
  });
  const bytes = (await Promise.all(files.map(fileSize))).reduce((a, b) => a + b, 0);
  const oversized = (
    await Promise.all(
      files.map(async (f) => ((await fileSize(f)) > OVERSIZE_LINE_THRESHOLD * ESTIMATED_BYTES_PER_LINE ? path.relative(codeDir, f) : null))
    )
  ).filter((s): s is string => !!s);

  const testFiles = await walkDir(testRoot, {
    fileFilter: (entry) => entry.name.endsWith(".test.ts")
  });
  const hasTests = testFiles.some(
    (f) => f.includes(`/${domainName}.`) || f.includes(`/${domainName}/`) || f.toLowerCase().includes(domainName.toLowerCase())
  );

  return { files: files.length, bytes, oversized, hasTests };
}

async function statsForDomain(root: string, domain: string): Promise<DomainStats> {
  return statsForDomainFromDir(
    path.join(root, "src", domain),
    path.join(root, "tests"),
    domain
  );
}

function gradeForStats(stats: DomainStats): { grade: QualityGrade; rationale: string } {
  if (stats.files === 0) {
    return { grade: "F", rationale: "No source files found for this domain." };
  }
  let score = 100;
  const reasons: string[] = [];
  if (stats.oversized.length) {
    score -= Math.min(40, stats.oversized.length * 10);
    reasons.push(`${stats.oversized.length} oversized file(s) (> ~${OVERSIZE_LINE_THRESHOLD} lines).`);
  }
  if (!stats.hasTests) {
    score -= 30;
    reasons.push("No tests reference this domain.");
  }
  const grade: QualityGrade = score >= 90 ? "A" : score >= 75 ? "B" : score >= 60 ? "C" : score >= 45 ? "D" : "F";
  if (!reasons.length) reasons.push("Healthy: no oversized files, tests reference this domain.");
  return { grade, rationale: reasons.join(" ") };
}

export async function readQualityFile(root: string): Promise<QualityFile> {
  return readJsonFile<QualityFile>(qualityPath(root), { updatedAt: "", domains: {} });
}

export async function computeQualityGrades(root: string): Promise<QualityFile> {
  const domains = await discoverDomains(root);
  const result: QualityFile = { updatedAt: new Date().toISOString(), domains: {} };
  for (const domain of domains) {
    const stats = await statsForDomain(root, domain);
    const { grade, rationale } = gradeForStats(stats);
    result.domains[domain] = {
      grade,
      rationale,
      evidence: [`src/${domain}`, ...stats.oversized],
      lastComputedAt: result.updatedAt
    };
  }
  await writeJsonFile(qualityPath(root), result);
  return result;
}

async function discoverProjectDomains(subjectPath: string): Promise<Array<{ prefix: string; name: string }>> {
  const domains: Array<{ prefix: string; name: string }> = [];

  // Flat source roots: src/, app/
  for (const rootName of ["src", "app"] as const) {
    const dir = path.join(subjectPath, rootName);
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          domains.push({ prefix: rootName, name: entry.name });
        }
      }
    } catch {
      // not found
    }
  }

  // Nested source roots: apps/*, packages/*
  for (const parentName of ["apps", "packages"]) {
    const parentDir = path.join(subjectPath, parentName);
    try {
      const entries = await readdir(parentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          domains.push({ prefix: parentName, name: entry.name });
        }
      }
    } catch {
      // not found
    }
  }

  return domains;
}

export interface ProjectQualityResult extends QualityFile {
  skipped?: boolean;
  reason?: string;
}

export async function computeProjectQualityGrades(
  _root: string,
  subjectPath: string
): Promise<ProjectQualityResult> {
  const domains = await discoverProjectDomains(subjectPath);
  if (!domains.length) {
    return {
      updatedAt: new Date().toISOString(),
      domains: {},
      skipped: true,
      reason: "No recognized source root (src/, app/, apps/*, packages/*)."
    };
  }

  const result: ProjectQualityResult = {
    updatedAt: new Date().toISOString(),
    domains: {}
  };

  for (const { prefix, name } of domains) {
    // For apps/* and packages/*, the source is typically inside a src/ subdirectory
    const codeDir = (prefix === "apps" || prefix === "packages")
      ? path.join(subjectPath, prefix, name, "src")
      : path.join(subjectPath, prefix, name);
    const stats = await statsForDomainFromDir(codeDir, path.join(subjectPath, "tests"), name);
    const { grade, rationale } = gradeForStats(stats);
    result.domains[name] = {
      grade,
      rationale,
      evidence: [`${prefix}/${name}`, ...stats.oversized],
      lastComputedAt: result.updatedAt
    };
  }

  return result;
}

