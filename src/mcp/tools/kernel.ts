import { listKernelSectionNames, readKernelSection } from "../../core/catalog/skills-catalog.ts";
import type { McpToolModule } from "../types.ts";
import { asText } from "../types.ts";

export const kernelTools: McpToolModule = {
  definitions: [
    {
      name: "kernel_read",
      description:
        "Read a kernel section by file name. Use when you need the full policy text, not just the compressed summary in the turn prompt.",
      inputSchema: {
        type: "object",
        properties: {
          section: {
            type: "string",
            description: "Kernel file basename, e.g. 'workflow-policy' or 'memory-policy'."
          }
        }
      }
    }
  ],
  handlers: {
    kernel_read: async (ctx, args) => {
      const section = typeof args["section"] === "string" ? args["section"] : "";
      if (!section) {
        const names = await listKernelSectionNames(ctx.root);
        return asText(names);
      }
      const result = await readKernelSection(ctx.root, section);
      return asText(result);
    }
  }
};