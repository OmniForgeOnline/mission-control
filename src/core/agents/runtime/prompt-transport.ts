import type { AgentToolConfig, PromptInputFormat, PromptTransport } from "../config/types.ts";

export interface PromptTransportPlan {
  transport: PromptTransport;
  inputFormat?: PromptInputFormat;
  keepOpen?: boolean;
}

export interface PromptBudgetError {
  code: "AGENT_PROMPT_TOO_LARGE";
  message: string;
  bytes: number;
  limit: number;
}

interface StdinLike {
  write(chunk: string, encoding?: string): unknown;
  end(chunk?: string, encoding?: string): unknown;
}

export function checkPromptBudget(tool: AgentToolConfig, prompt: string): PromptBudgetError | null {
  if ((tool.promptTransport ?? "stdin") !== "argv" || typeof tool.maxPromptArgBytes !== "number") return null;
  const bytes = Buffer.byteLength(prompt, "utf8");
  if (bytes <= tool.maxPromptArgBytes) return null;
  return {
    code: "AGENT_PROMPT_TOO_LARGE",
    message: `${tool.displayName} requires the prompt as a command-line argument and this prompt is too large (${bytes} > ${tool.maxPromptArgBytes} bytes). Use stdin/file prompt transport or reduce context.`,
    bytes,
    limit: tool.maxPromptArgBytes
  };
}

export function promptTransportForLaunch(
  tool: AgentToolConfig,
  launch: { promptOnStdin: boolean; inputStreamJson?: boolean }
): PromptTransportPlan {
  if (launch.inputStreamJson) return { transport: "stdin", inputFormat: "stream-json" };
  if (tool.promptTransport === "file") return { transport: "file", inputFormat: tool.promptInputFormat ?? "text" };
  if (tool.promptTransport === "argv" || !launch.promptOnStdin) return { transport: "argv" };
  return { transport: "stdin", inputFormat: tool.promptInputFormat ?? "text" };
}

export function deliverPrompt(stdin: StdinLike, plan: PromptTransportPlan, prompt: string): void {
  if (plan.transport !== "stdin") {
    stdin.end();
    return;
  }
  if (plan.inputFormat === "stream-json") {
    stdin.write(streamJsonUserMessage(prompt), "utf8");
    if (!plan.keepOpen) stdin.end();
    return;
  }
  stdin.end(prompt, "utf8");
}

export function streamJsonUserMessage(text: string): string {
  return `${JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] }
  })}\n`;
}
