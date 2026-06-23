import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { listFileNames } from "../infra/fs.ts";
import { resolveSkillCategory, type SkillCategoryId } from "./skill-categories.ts";

const SKILL_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

function assertValidSkillName(name: string): void {
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new Error("Invalid skill name.");
  }
}

function parseSkillDescription(body: string): string {
  return body.match(/description:\s*(.+)/)?.[1]?.trim() ?? "";
}

export interface SkillSummary {
  name: string;
  description: string;
}

export interface SkillSummaryWithCategory extends SkillSummary {
  category: SkillCategoryId;
}

export async function listSkills(root: string): Promise<SkillSummary[]> {
  const dir = path.join(root, "skills");
  const names = (await listFileNames(dir)).sort();
  const out: SkillSummary[] = [];
  for (const skillName of names) {
    if (skillName === "README.md") continue;
    try {
      const body = await readFile(path.join(dir, skillName, "SKILL.md"), "utf8");
      out.push({ name: skillName, description: parseSkillDescription(body) });
    } catch {
      /* skip */
    }
  }
  return out;
}

export async function listSkillsWithCategories(root: string): Promise<SkillSummaryWithCategory[]> {
  const dir = path.join(root, "skills");
  const entries = await readdir(dir).catch(() => [] as string[]);
  const skills: SkillSummaryWithCategory[] = [];
  for (const name of entries.sort()) {
    if (name === "README.md") continue;
    try {
      const body = await readFile(path.join(dir, name, "SKILL.md"), "utf8");
      const description = parseSkillDescription(body);
      const frontmatterCategory = body.match(/category:\s*(.+)/)?.[1]?.trim();
      const category = resolveSkillCategory(name, frontmatterCategory).id;
      skills.push({ name, description, category });
    } catch {
      /* skip */
    }
  }
  return skills;
}

export async function readSkill(root: string, name: string): Promise<{ name: string; content: string }> {
  assertValidSkillName(name);
  const content = await readFile(path.join(root, "skills", name, "SKILL.md"), "utf8");
  return { name, content };
}

const FRONTMATTER_PATTERN = /^---\n[\s\S]*?\n---\n?/;

function extractFrontmatter(content: string): string {
  return content.match(FRONTMATTER_PATTERN)?.[0] ?? "";
}

/**
 * Persist an operator edit to a skill's SKILL.md.
 *
 * If the incoming content already carries its own `---` frontmatter block it is
 * written verbatim (the operator is editing frontmatter intentionally).
 * Otherwise the existing frontmatter is preserved and only the body is replaced,
 * so name/description/category survive a body-only edit and the skill stays
 * loadable and categorizable.
 */
export async function writeSkill(
  root: string,
  name: string,
  content: string
): Promise<{ name: string; content: string }> {
  assertValidSkillName(name);
  const file = path.join(root, "skills", name, "SKILL.md");
  // Reading first guarantees the skill exists (ENOENT → caller maps to 404)
  // and gives us the frontmatter to preserve on body-only edits.
  const existing = await readFile(file, "utf8");
  const carriesFrontmatter = FRONTMATTER_PATTERN.test(content);
  const next = carriesFrontmatter ? content : extractFrontmatter(existing) + content;
  await writeFile(file, next, "utf8");
  return { name, content: next };
}

export async function listKernelSectionNames(root: string): Promise<string[]> {
  const dir = path.join(root, "kernel");
  const entries = await readdir(dir).catch(() => [] as string[]);
  return entries
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.replace(/\.md$/, ""))
    .sort();
}

export async function readKernelSection(
  root: string,
  section: string
): Promise<{ section: string; content: string }> {
  const safe = section.replace(/[^a-z0-9-]/gi, "");
  const content = await readFile(path.join(root, "kernel", `${safe}.md`), "utf8");
  return { section: safe, content };
}