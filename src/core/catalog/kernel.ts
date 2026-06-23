import { readFile } from "node:fs/promises";
import path from "node:path";

import { listFileNames } from "../infra/fs.ts";

async function readIfPresent(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

/**
 * Concatenate every kernel/*.md file (sorted by name) into a single string.
 * Each section is wrapped in a marker comment so the agent can see where
 * each policy comes from. This is the same content the old export step
 * wrote to exports/<tool>/*.md, but pulled fresh per task turn instead of
 * via a separate generated file.
 */
export async function loadKernelText(root: string): Promise<string> {
  const dir = path.join(root, "kernel");
  const names = (await listFileNames(dir)).filter((name) => name.endsWith(".md")).sort();
  const parts = await Promise.all(
    names.map(async (name) => {
      const content = (await readIfPresent(path.join(dir, name))).trim();
      if (!content) return "";
      return `<!-- kernel/${name} -->\n${content}\n`;
    })
  );
  return parts.filter(Boolean).join("\n");
}

/**
 * Render an inventory line for each approved harness skill. Returns
 * "- <name>: <description> (skills/<name>/SKILL.md)" lines, or a single
 * placeholder line when no skills exist.
 */
export async function loadSkillsIndex(root: string): Promise<string> {
  const dir = path.join(root, "skills");
  const names = (await listFileNames(dir)).sort();
  const entries: string[] = [];
  for (const name of names) {
    if (name === "README.md") continue;
    const content = (await readIfPresent(path.join(dir, name, "SKILL.md"))).trim();
    if (!content) continue;
    const description = content.match(/description:\s*(.+)/)?.[1]?.trim() ?? "Harness skill";
    entries.push(`- ${name}: ${description} (skills/${name}/SKILL.md)`);
  }
  return entries.length ? entries.join("\n") : "- No approved harness skills yet.";
}
