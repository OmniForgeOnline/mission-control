import { listHooks } from "../../core/review/hooks.ts";
import type { McpToolModule } from "../types.ts";
import { asText } from "../types.ts";

export const hookTools: McpToolModule = {
  definitions: [
    {
      name: "list_hooks",
      description: "Read and return hooks from .harness/hooks.yml in the workspace.",
      inputSchema: { type: "object", properties: {} }
    }
  ],
  handlers: {
    list_hooks: async (ctx) => asText(await listHooks(ctx.root))
  }
};