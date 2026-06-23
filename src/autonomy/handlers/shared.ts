import { readFile } from "node:fs/promises";
import path from "node:path";

export async function readOptionalFile(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

export async function collectMarkdown(dir: string): Promise<string[]> {
  try {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(dir, { withFileTypes: true });
    const out: string[] = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await collectMarkdown(full)));
      else if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
    }
    return out;
  } catch {
    return [];
  }
}