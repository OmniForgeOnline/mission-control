import { captureMemoryFromAgent } from "../../memory/capture.ts";
import { searchMemoryIndex } from "../../memory/index.ts";
import { getMemoryPage, listMemoryPages, searchMemoryPages } from "../../memory/store.ts";
import type { McpToolModule } from "../types.ts";
import { asText } from "../types.ts";

export const memoryTools: McpToolModule = {
  definitions: [
    {
      name: "gbrain_search",
      description:
        "Full-text search across the harness's durable memory store (data/memory/pages/). Returns ranked matches with snippets. Use this first when prior preferences, decisions, or project context might exist.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" }, limit: { type: "number" } },
        required: ["query"]
      }
    },
    {
      name: "gbrain_index_search",
      description:
        "Search the wider harness memory index (pages + run artifacts + proposals). Use when gbrain_search misses.",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
    },
    {
      name: "gbrain_read",
      description: "Read a single memory page by slug.",
      inputSchema: { type: "object", properties: { slug: { type: "string" } }, required: ["slug"] }
    },
    {
      name: "gbrain_list",
      description: "List memory pages, optionally filtered by slug prefix.",
      inputSchema: { type: "object", properties: { prefix: { type: "string" }, limit: { type: "number" } } }
    },
    {
      name: "gbrain_propose",
      description:
        "Capture durable personal memory locally under data/memory/pages/ (gitignored). Writes immediately — no task, worktree, or PR workflow.",
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Path under data/memory/pages/, no extension." },
          title: { type: "string" },
          content: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          type: { type: "string", description: "note | preference | decision | project | entity" },
          rationale: { type: "string" }
        },
        required: ["slug", "title", "content", "rationale"]
      }
    }
  ],
  handlers: {
    gbrain_search: async (ctx, args) => {
      const query = String(args["query"] ?? "").trim();
      const limit = Number(args["limit"] ?? 8);
      if (!ctx.projectId) return asText([]);
      const hits = await searchMemoryPages(ctx.root, ctx.projectId, query);
      return asText(hits.slice(0, limit).map((h) => ({ slug: h.slug, title: h.title, score: h.score, snippet: h.snippet })));
    },
    gbrain_index_search: async (ctx, args) => {
      if (!ctx.projectId) return asText([]);
      const hits = await searchMemoryIndex(ctx.root, ctx.projectId, String(args["query"] ?? ""));
      return asText(hits);
    },
    gbrain_read: async (ctx, args) => {
      if (!ctx.projectId) throw new Error("gbrain_read requires a project context.");
      const page = await getMemoryPage(ctx.root, ctx.projectId, String(args["slug"]));
      return asText({ slug: page.slug, title: page.title, type: page.type, tags: page.tags, content: page.content });
    },
    gbrain_list: async (ctx, args) => {
      const prefix = typeof args["prefix"] === "string" ? args["prefix"] : "";
      const limit = Number(args["limit"] ?? 50);
      if (!ctx.projectId) return asText([]);
      const all = await listMemoryPages(ctx.root, ctx.projectId);
      const filtered = prefix ? all.filter((p) => p.slug.startsWith(prefix)) : all;
      return asText(filtered.slice(0, limit).map((p) => ({ slug: p.slug, title: p.title, tags: p.tags })));
    },
    gbrain_propose: async (ctx, args) => {
      if (!ctx.projectId) throw new Error("gbrain_propose requires a project context.");
      const slug = String(args["slug"]);
      const title = String(args["title"]);
      const content = String(args["content"]);
      const rationale = typeof args["rationale"] === "string" ? args["rationale"] : "";
      const tags = Array.isArray(args["tags"]) ? args["tags"].map(String) : [];
      const type = typeof args["type"] === "string" ? args["type"] : "note";
      const captured = await captureMemoryFromAgent(ctx.root, ctx.projectId, { slug, title, content, rationale, tags, type });
      return asText({
        slug,
        title: captured.title,
        status: captured.status,
        targetPath: captured.targetPath,
        captured: true
      });
    }
  }
};
