export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolContext {
  root: string;
  runId: string;
  /** Project the current turn belongs to; scopes all memory tools. */
  projectId?: string;
}

export type McpToolHandler = (
  ctx: McpToolContext,
  args: Record<string, unknown>
) => Promise<unknown>;

export interface McpToolModule {
  definitions: McpToolDefinition[];
  handlers: Record<string, McpToolHandler>;
}

export function asText(payload: unknown): JsonRpcResponse["result"] {
  return {
    content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2) }]
  };
}
