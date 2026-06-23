import { marked } from "marked";

import {
  healStreamedMarkdown,
  normalizeEscapedNewlines,
  prepareDescriptionForMarkdown,
  prepareTextForMarkdown
} from "@harness/core/agents/output.ts";

marked.setOptions({
  breaks: true,
  gfm: true
});

export function stripFrontmatter(content: string): string {
  if (!content.startsWith("---\n")) return content;
  const end = content.indexOf("\n---", 4);
  if (end === -1) return content;
  return content.slice(end + 4).replace(/^\n/, "");
}

export function renderMarkdown(
  text: string,
  kind: "message" | "description" | "part" = "message"
): string {
  const prepared =
    kind === "description"
      ? prepareDescriptionForMarkdown(text)
      : kind === "part"
      ? healStreamedMarkdown(normalizeEscapedNewlines(text))
      : prepareTextForMarkdown(text);
  return marked.parse(prepared) as string;
}
