import path from "node:path";

import { readJsonFile } from "../../core/infra/fs.ts";
import type { McpToolModule } from "../types.ts";
import { asText } from "../types.ts";

interface QualityFile {
  updatedAt?: string;
  domains?: Record<string, { grade: string; rationale?: string; evidence?: string[]; lastComputedAt?: string }>;
}

export const qualityTools: McpToolModule = {
  definitions: [
    {
      name: "quality_grades",
      description: "Read computed quality grades from state/quality.json.",
      inputSchema: { type: "object", properties: { domain: { type: "string" } } }
    }
  ],
  handlers: {
    quality_grades: async (ctx, args) => {
      const data = await readJsonFile<QualityFile>(path.join(ctx.root, "data", "state", "quality.json"), {});
      const domain = typeof args["domain"] === "string" ? args["domain"] : undefined;
      if (domain && data.domains) {
        return asText({ updatedAt: data.updatedAt, [domain]: data.domains[domain] ?? null });
      }
      return asText(data);
    }
  }
};