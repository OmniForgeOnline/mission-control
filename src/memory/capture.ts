import type { CreateProposalInput, HarnessProposal } from "../core/types.ts";
import type { MemoryPage } from "./store.ts";
import { captureMemoryPage } from "./store.ts";

function memorySlugFromTargetPath(targetPath: string): string {
  const normalized = targetPath.trim().replace(/\\/g, "/");
  const prefix = "data/memory/pages/";
  if (!normalized.startsWith(prefix)) {
    throw new Error("Memory targetPath must be under data/memory/pages/.");
  }
  const slug = normalized.slice(prefix.length).replace(/\.md$/i, "");
  if (!slug || slug.includes("..")) {
    throw new Error("Memory slug must be a safe relative path.");
  }
  return slug;
}

function parseMemoryProposalContent(content: string): { type: string; tags: string[]; body: string } {
  if (!content.startsWith("---\n")) {
    return { type: "note", tags: [], body: content.trim() };
  }
  const end = content.indexOf("\n---", 4);
  if (end === -1) {
    return { type: "note", tags: [], body: content.trim() };
  }

  const frontmatter = content.slice(4, end).trim();
  const body = content.slice(end + 4).trim();
  let type = "note";
  const tags: string[] = [];

  for (const line of frontmatter.split("\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key === "type" && value) type = value;
    if (key === "tags" && value.startsWith("[") && value.endsWith("]")) {
      tags.push(
        ...value
          .slice(1, -1)
          .split(",")
          .map((tag) => tag.trim().replace(/^"|"$/g, ""))
          .filter(Boolean)
      );
    }
  }

  return { type, tags, body };
}

function withOptionalRationale(body: string, rationale: string): string {
  const trimmed = body.trim();
  const why = rationale.trim();
  if (!why) return trimmed;
  return `${trimmed}\n\n## Rationale\n\n${why}`;
}

function memoryProposalRecord(
  input: Pick<CreateProposalInput, "rationale" | "targetPath" | "content">,
  page: MemoryPage
): HarnessProposal {
  return {
    id: `memory:${page.slug}`,
    kind: "memory",
    title: page.title,
    rationale: input.rationale,
    targetPath: input.targetPath.trim(),
    content: input.content,
    status: "approved",
    createdAt: page.updatedAt,
    updatedAt: page.updatedAt,
    reviewedAt: page.updatedAt
  };
}

/**
 * Write memory directly to the local wiki. Personal memory never creates tasks,
 * worktrees, or PRs — it stays under gitignored data/memory/pages/.
 */
export async function captureMemoryProposal(
  root: string,
  projectId: string,
  input: CreateProposalInput
): Promise<HarnessProposal> {
  const slug = memorySlugFromTargetPath(input.targetPath);
  const parsed = parseMemoryProposalContent(input.content);
  const page = await captureMemoryPage(root, projectId, {
    slug,
    type: parsed.type,
    title: input.title.trim(),
    tags: parsed.tags,
    content: withOptionalRationale(parsed.body, input.rationale)
  });
  return memoryProposalRecord(input, page);
}

export async function captureMemoryFromAgent(
  root: string,
  projectId: string,
  input: {
    slug: string;
    title: string;
    content: string;
    rationale?: string;
    type?: string;
    tags?: string[];
  }
): Promise<HarnessProposal> {
  const page = await captureMemoryPage(root, projectId, {
    slug: input.slug,
    type: input.type?.trim() || "note",
    title: input.title.trim(),
    tags: input.tags ?? [],
    content: withOptionalRationale(input.content, input.rationale ?? "")
  });
  return memoryProposalRecord(
    {
      rationale: input.rationale ?? "",
      targetPath: `data/memory/pages/${input.slug}.md`,
      content: input.content
    },
    page
  );
}