import { hookTools } from "./tools/hooks.ts";
import { kernelTools } from "./tools/kernel.ts";
import { memoryTools } from "./tools/memory.ts";
import { proposalTools } from "./tools/proposals.ts";
import { skillTools } from "./tools/skills.ts";
import { taskTools } from "./tools/tasks.ts";
import type { McpToolContext, McpToolDefinition, McpToolHandler } from "./types.ts";

const MODULES = [memoryTools, proposalTools, taskTools, kernelTools, skillTools, hookTools];

export const TOOL_DEFS: McpToolDefinition[] = MODULES.flatMap((module) => module.definitions);

const HANDLERS = new Map<string, McpToolHandler>(
  MODULES.flatMap((module) => Object.entries(module.handlers))
);

export async function callTool(
  ctx: McpToolContext,
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const handler = HANDLERS.get(name);
  if (!handler) throw new Error(`Unknown tool: ${name}`);
  return handler(ctx, args);
}