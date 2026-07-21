import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { DEFAULT_SKILLS } from "../bootstrap/defaults/skills.ts";
import { bundledSkillsDir } from "./paths.ts";
import { hashBody } from "./hash.ts";
import type { AssetStatus, SkillAsset, SkillBodySource } from "./types.ts";

const SKILL_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

function seededSkillIds(): string[] {
  return [
    ...new Set(
      Object.keys(DEFAULT_SKILLS).map((fileName) => fileName.split("/")[0]!).filter(Boolean)
    )
  ].sort();
}

async function readPackagedSkillIds(): Promise<string[]> {
  const dir = bundledSkillsDir();
  const entries = await readdir(dir).catch(() => [] as string[]);
  return entries.filter((name) => SKILL_NAME_PATTERN.test(name)).sort();
}

async function readRuntimeSkillIds(root: string): Promise<string[]> {
  const dir = path.join(root, "skills");
  const entries = await readdir(dir).catch(() => [] as string[]);
  const ids: string[] = [];
  for (const name of entries) {
    if (!SKILL_NAME_PATTERN.test(name)) continue;
    try {
      await readFile(path.join(dir, name, "SKILL.md"), "utf8");
      ids.push(name);
    } catch {
      /* skip */
    }
  }
  return ids.sort();
}

async function readSkillBodyFromPath(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function readPackagedSkillBody(skillId: string): Promise<string | null> {
  return readSkillBodyFromPath(path.join(bundledSkillsDir(), skillId, "SKILL.md"));
}

function readSeededSkillBody(skillId: string): string | null {
  return DEFAULT_SKILLS[`${skillId}/SKILL.md`] ?? null;
}

async function readRuntimeSkillBody(root: string, skillId: string): Promise<string | null> {
  return readSkillBodyFromPath(path.join(root, "skills", skillId, "SKILL.md"));
}

function classifySkill(
  packaged: boolean,
  seeded: boolean,
  runtime: boolean,
  packagedBody: string | null,
  seededBody: string | null,
  runtimeBody: string | null,
  referenced: boolean
): AssetStatus {
  if (referenced && !packaged && !seeded && !runtime) {
    return "invalid-reference";
  }
  if (runtime) {
    const baseline = packagedBody ?? seededBody;
    if (!baseline) return "runtime-only";
    const runtimeHash = runtimeBody ? hashBody(runtimeBody) : undefined;
    const baselineHash = hashBody(baseline);
    return runtimeHash === baselineHash ? "unchanged" : "runtime-customized";
  }
  if (packaged || seeded) return "bundled-only";
  return referenced ? "invalid-reference" : "bundled-only";
}

export async function inventorySkills(
  root: string,
  referencedSkillIds: string[]
): Promise<{ skills: SkillAsset[]; contradictorySkillBodies: Array<{ skill: string; sources: SkillBodySource[] }> }> {
  const packagedIds = await readPackagedSkillIds();
  const seededIds = seededSkillIds();
  const runtimeIds = await readRuntimeSkillIds(root);
  const referenced = new Set(referencedSkillIds);
  const allIds = [...new Set([...packagedIds, ...seededIds, ...runtimeIds, ...referencedSkillIds])].sort();

  const skills: SkillAsset[] = [];
  const contradictorySkillBodies: Array<{ skill: string; sources: SkillBodySource[] }> = [];

  for (const id of allIds) {
    const packaged = packagedIds.includes(id);
    const seeded = seededIds.includes(id);
    const runtime = runtimeIds.includes(id);
    const packagedBody = packaged ? await readPackagedSkillBody(id) : null;
    const seededBody = seeded ? readSeededSkillBody(id) : null;
    const runtimeBody = runtime ? await readRuntimeSkillBody(root, id) : null;

    const status = classifySkill(
      packaged,
      seeded,
      runtime,
      packagedBody,
      seededBody,
      runtimeBody,
      referenced.has(id)
    );

    const bodyHash = runtimeBody
      ? hashBody(runtimeBody)
      : packagedBody
        ? hashBody(packagedBody)
        : seededBody
          ? hashBody(seededBody)
          : undefined;

    skills.push({
      id,
      status,
      packaged,
      seeded,
      runtime,
      ...(bodyHash ? { bodyHash } : {})
    });

    const sources: SkillBodySource[] = [];
    if (packagedBody) sources.push({ source: "packaged", bodyHash: hashBody(packagedBody) });
    if (seededBody) sources.push({ source: "seeded", bodyHash: hashBody(seededBody) });
    if (runtimeBody) sources.push({ source: "runtime", bodyHash: hashBody(runtimeBody) });
    const uniqueHashes = new Set(sources.map((source) => source.bodyHash));
    if (sources.length >= 2 && uniqueHashes.size > 1) {
      contradictorySkillBodies.push({ skill: id, sources });
    }
  }

  return { skills, contradictorySkillBodies };
}

export function missingSkillPackaging(
  referencedSkillIds: string[],
  skills: SkillAsset[]
): string[] {
  const byId = new Map(skills.map((skill) => [skill.id, skill]));
  return referencedSkillIds.filter((skillId) => {
    const skill = byId.get(skillId);
    if (!skill) return true;
    if (skill.status === "invalid-reference") return true;
    return !skill.runtime;
  });
}
