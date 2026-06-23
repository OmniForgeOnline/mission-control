/**
 * Normalize and parse agent CLI output for storage and UI display.
 * Handles codex NDJSON streams, literal \\n escapes, and planning turn headers.
 */

import { repairStreamedTables } from "../infra/markdown-tables.ts";
import { extractPlanBody, hasPlanMarker } from "../prompts/plan-markers.ts";

function tryJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function firstString(obj: unknown, keys: string[]): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const record = obj as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

function textFromContent(content: unknown): string | undefined {
  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof (part as Record<string, unknown>)["text"] === "string") {
          return (part as Record<string, unknown>)["text"] as string;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
    return text || undefined;
  }
  if (typeof content === "string") return content.trim() || undefined;
  return undefined;
}

function extractClaudeStyleMessage(event: unknown): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const record = event as Record<string, unknown>;
  if (record["type"] === "result" || record["type"] === "final") {
    return firstString(record, ["result", "response", "text", "content"]);
  }
  if (record["type"] === "assistant" || record["role"] === "assistant") {
    return (
      firstString(record, ["text", "content", "message"]) ?? textFromContent(record["content"])
    );
  }
  const message = record["message"];
  if (message && typeof message === "object") {
    return textFromContent((message as Record<string, unknown>)["content"]);
  }
  return undefined;
}

function extractCodexAssistantMessage(event: unknown): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const record = event as Record<string, unknown>;
  const type = record["type"] ?? record["event"] ?? record["kind"];

  if (type === "item.completed" && record["item"] && typeof record["item"] === "object") {
    const item = record["item"] as Record<string, unknown>;
    const itemType = item["type"] ?? item["event"] ?? item["kind"];
    if (itemType === "agent_message" || itemType === "assistant_message") {
      const text = firstString(item, ["text", "message", "content"]);
      if (text) return text;
    }
  }

  const inner = (record["msg"] as Record<string, unknown> | undefined) ?? record;
  const innerType = inner["type"] ?? inner["event"] ?? inner["kind"] ?? type;
  const isAgentMessage =
    innerType === "agent_message" ||
    innerType === "assistant_message" ||
    innerType === "message" ||
    innerType === "task_complete";
  if (!isAgentMessage) return undefined;
  const message =
    firstString(inner, ["message", "content", "text", "last_message", "result"]) ?? undefined;
  if (message) return message;
  return textFromContent(inner["content"]);
}

/** Convert literal \\n / \\t sequences (from leaked JSON strings) into real whitespace. */
export function normalizeEscapedNewlines(text: string): string {
  if (!text.includes("\\n")) return text;
  const literalCount = (text.match(/\\n/g) ?? []).length;
  if (literalCount < 2) return text;
  return text.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
}

function looksLikeNdjsonStream(content: string): boolean {
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return false;
  const jsonLines = lines.filter((line) => line.startsWith("{"));
  return jsonLines.length >= 2 && jsonLines.length / lines.length >= 0.5;
}

function looksLikeGrokStreamingOutput(stdout: string): boolean {
  for (const event of iterGrokStreamEvents(stdout)) {
    const type = event["type"];
    if (type === "text" || type === "thought" || type === "error" || type === "end") return true;
  }
  return false;
}

function unescapeJsonString(raw: string): string {
  try {
    return JSON.parse(`"${raw.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`) as string;
  } catch {
    return raw
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
}

/** Recover grok events when JSON.parse fails (e.g. literal newlines inside data). */
function parseBrokenGrokEvent(raw: string): Record<string, unknown> | null {
  const typeMatch = raw.match(/"type"\s*:\s*"([^"]+)"/);
  if (!typeMatch) return null;
  const type = typeMatch[1];

  const dataMatch = raw.match(/"data"\s*:\s*"([\s\S]*)"\s*\}$/);
  const dataValue = dataMatch?.[1];
  if (dataValue) {
    return { type, data: unescapeJsonString(dataValue) };
  }

  const messageMatch = raw.match(/"message"\s*:\s*"([\s\S]*)"\s*\}$/);
  const messageValue = messageMatch?.[1];
  if (messageValue) {
    return { type, message: unescapeJsonString(messageValue) };
  }

  if (type === "end") {
    const sessionId = raw.match(/"sessionId"\s*:\s*"([^"]+)"/)?.[1];
    return sessionId ? { type, sessionId } : { type };
  }

  return null;
}

/** Line-oriented grok stream parser; joins multiline JSON and regex-fallbacks broken events. */
function* iterGrokStreamEvents(stdout: string): Generator<Record<string, unknown>> {
  const lines = stdout.split(/\r?\n/);
  let pending = "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    pending = pending ? `${pending}\n${trimmed}` : trimmed;
    if (!pending.startsWith("{")) {
      pending = "";
      continue;
    }

    const event =
      (tryJson(pending) as Record<string, unknown> | null) ?? parseBrokenGrokEvent(pending);
    if (event) {
      yield event;
      pending = "";
    } else if (pending.length > 20_000) {
      pending = "";
    }
  }

  if (pending) {
    const event =
      (tryJson(pending) as Record<string, unknown> | null) ?? parseBrokenGrokEvent(pending);
    if (event) yield event;
  }
}

/** Walk stdout and yield each top-level JSON object, even when chunks lack newlines. */
function* iterJsonObjects(text: string): Generator<unknown> {
  let index = 0;
  while (index < text.length) {
    const start = text.indexOf("{", index);
    if (start === -1) break;

    let depth = 0;
    let inString = false;
    let escaped = false;
    let parsed: unknown | undefined;

    for (let cursor = start; cursor < text.length; cursor++) {
      const ch = text[cursor];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          parsed = tryJson(text.slice(start, cursor + 1));
          index = cursor + 1;
          break;
        }
      }
    }

    if (parsed === undefined) break;
    yield parsed;
  }
}

function extractGrokStreamingChunk(
  event: unknown
): { text?: string; error?: string; sessionId?: string } | undefined {
  if (!event || typeof event !== "object") return undefined;
  const record = event as Record<string, unknown>;
  const type = record["type"];

  if (type === "text" && typeof record["data"] === "string") {
    return { text: record["data"] };
  }
  if (type === "error") {
    const error = firstString(record, ["message", "data", "error"]);
    return error ? { error } : undefined;
  }
  if (type === "end") {
    const sessionId = firstString(record, ["sessionId", "session_id", "thread_id", "threadId"]);
    return sessionId ? { sessionId } : undefined;
  }
  return undefined;
}

/** Repair markdown structure after token-by-token grok streaming concatenation. */
export function healStreamedMarkdown(text: string): string {
  let result = text;

  result = result.replace(/<proposed_plan(?=[#\s])/gi, "<proposed_plan>\n\n");
  result = result.replace(/<\/proposed_plan(?!>)/gi, "</proposed_plan>");

  result = result.replace(/([^\n#\s])(#{1,6}\s)/g, "$1\n\n$2");
  const headerBodyStarters =
    "No|The|Many|Existing|Run|Add|Create|Verify|After|Before|Target|Total|First|Optionally|Work|Commit|Push|Scope|Dependencies|New|Mechanical|Refactoring|Changing|Consolidating|Broad|Substring|Duplicate";
  result = result.replace(
    new RegExp(`(#{1,6}\\s+)([A-Z][a-z]+)(${headerBodyStarters})\\b`, "g"),
    "$1$2\n\n$3"
  );
  result = result.replace(/(### Step \d+)(Do|Run|Verify|Add|Create|Work|Commit|Push|Confirm)\b/g, "$1\n\n$2");
  // Require a same-line space after -/*; never treat "- |" inside table rows as a list marker.
  result = result.replace(/([^\n-*\d|])([-*] [^\s|])/g, "$1\n$2");
  result = result.replace(/([^\n\d|])(\d+\. [^\s|])/g, "$1\n$2");

  const gluedStarters =
    "Checking|Planning|The|This|Many|None|Existing|New|Run|Add|Create|Verify|After|Before|Per|Step|First|Interesting|Now|Let|Bring|Dependencies|Total|Optionally|Work|Commit|Push|Scope|Target|Success|Out";
  result = result.replace(new RegExp(`([a-z])(${gluedStarters})\\b`, "g"), "$1 $2");
  result = result.replace(/([.!?])([A-Z])/g, "$1\n\n$2");
  result = result.replace(/\n{3,}/g, "\n\n");

  return result.trim();
}

/** Parse grok CLI streaming-json output (thought/text/end chunks) into readable text. */
export function parseGrokStreamingOutput(stdout: string): ParsedAgentOutput {
  const textParts: string[] = [];
  const errors: string[] = [];
  let sessionId: string | undefined;

  for (const event of iterGrokStreamEvents(stdout)) {
    const sid = extractSessionIdFromStreamEvent(event);
    if (sid) sessionId = sid;
    const chunk = extractGrokStreamingChunk(event);
    if (!chunk) continue;
    if (chunk.text) textParts.push(chunk.text);
    if (chunk.error) errors.push(chunk.error);
    if (chunk.sessionId) sessionId = chunk.sessionId;
  }

  const reply = healStreamedMarkdown(
    normalizeEscapedNewlines((textParts.join("") || errors.join("\n\n") || "").trim())
  );
  return { reply, ...(sessionId !== undefined ? { sessionId } : {}) };
}

/** Parse a newline-delimited agent JSON stream into human-readable assistant text. */
export function parseAgentStreamOutput(stdout: string): string {
  if (looksLikeGrokStreamingOutput(stdout)) {
    const parsed = parseGrokStreamingOutput(stdout);
    if (parsed.reply) return parsed.reply;
  }

  const agentTexts: string[] = [];
  let sawStructuredEvent = false;
  for (const event of iterJsonObjects(stdout)) {
    if (!event || typeof event !== "object") continue;
    sawStructuredEvent = true;
    const text = extractCodexAssistantMessage(event) ?? extractClaudeStyleMessage(event);
    if (text) agentTexts.push(text);
  }

  if (agentTexts.length) return agentTexts.join("\n\n");
  return sawStructuredEvent ? "" : stdout.trim();
}

const TURN_HEADER_RE = /^(###[^\n]+\n\n)/;

/** Clean a stored or live agent message body for display/storage. */
export function sanitizeAgentMessageBody(body: string): string {
  const headerMatch = body.match(TURN_HEADER_RE);
  const prefix = headerMatch?.[1] ?? "";
  const content = headerMatch ? body.slice(prefix.length) : body;

  if (looksLikeNdjsonStream(content) || looksLikeGrokStreamingOutput(content)) {
    const parsed = parseAgentStreamOutput(content);
    return prefix + repairStreamedTables(healStreamedMarkdown(normalizeEscapedNewlines(parsed)));
  }

  return repairStreamedTables(healStreamedMarkdown(normalizeEscapedNewlines(body)));
}

function stripFinalPlanWrapper(text: string): string {
  const headerMatch = text.match(TURN_HEADER_RE);
  const prefix = headerMatch?.[1] ?? "";
  const content = healStreamedMarkdown(headerMatch ? text.slice(prefix.length) : text);
  const normalized = content
    .replace(/```(?:markdown|md)?\s*\n?/gi, "")
    .replace(/```/g, "")
    .trim();
  const planBody = extractPlanBody(normalized);
  if (planBody) {
    return `${prefix}${healStreamedMarkdown(planBody)}`;
  }
  return healStreamedMarkdown(text.replace(/^FINAL_PLAN:\s*/im, "").trim());
}

/** Prepare arbitrary markdown-bearing text for rendering. */
export function prepareTextForMarkdown(text: string): string {
  const sanitized = sanitizeAgentMessageBody(text);
  const content = hasPlanMarker(sanitized) ? stripFinalPlanWrapper(sanitized) : sanitized;
  return repairStreamedTables(content);
}

export function prepareDescriptionForMarkdown(description: string): string {
  return normalizeEscapedNewlines(description);
}

export interface ParsedAgentOutput {
  reply: string;
  sessionId?: string;
}

/** Extract a resumable session id from a single streamed agent event. */
export function extractSessionIdFromStreamEvent(event: unknown): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const record = event as Record<string, unknown>;

  const direct = firstString(record, ["session_id", "sessionId", "thread_id", "threadId"]);
  if (direct) return direct;

  if (record["session"] && typeof record["session"] === "object") {
    const nested = firstString(record["session"], ["id", "session_id", "thread_id", "threadId"]);
    if (nested) return nested;
  }

  const msg = record["msg"];
  if (msg && typeof msg === "object") {
    const fromMsg = extractSessionIdFromStreamEvent(msg);
    if (fromMsg) return fromMsg;
  }

  const type = String(record["type"] ?? record["event"] ?? "");
  if (type === "session_configured" || type === "session.created" || type === "thread.started") {
    return (
      firstString(record, ["session_id", "thread_id", "id"]) ??
      firstString(record["session"], ["id", "session_id", "thread_id"])
    );
  }

  if (type === "end") {
    return firstString(record, ["sessionId", "session_id", "thread_id", "threadId"]);
  }

  return undefined;
}

/** Parse full agent stdout (all supported CLI formats). */
export function parseAgentOutput(stdout: string, agent: string): ParsedAgentOutput {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (agent === "grok") {
    if (looksLikeGrokStreamingOutput(stdout)) {
      return parseGrokStreamingOutput(stdout);
    }
  }

  if (agent === "grok" || agent === "claude" || agent === "opencode") {
    let sessionId: string | undefined;
    let resultReply: string | undefined;
    const assistantTexts: string[] = [];
    let sawStructuredEvent = false;
    for (const line of lines) {
      const event = tryJson(line);
      if (!event || typeof event !== "object") continue;
      sawStructuredEvent = true;
      const record = event as Record<string, unknown>;
      const sid = extractSessionIdFromStreamEvent(event);
      if (sid) sessionId = sid;
      if (record["type"] === "result" || record["type"] === "final") {
        resultReply =
          firstString(record, ["result", "response", "text", "content"]) ?? resultReply;
      } else {
        const text = extractClaudeStyleMessage(event);
        if (text && assistantTexts[assistantTexts.length - 1] !== text) assistantTexts.push(text);
      }
    }
    const assistantReply = assistantTexts.join("\n\n");
    const fallbackReply = sawStructuredEvent ? "" : stdout.trim();
    const replyText = resultReply ?? (assistantReply || fallbackReply);
    const reply = normalizeEscapedNewlines(replyText.trim());
    return { reply, ...(sessionId !== undefined ? { sessionId } : {}) };
  }

  let sessionId: string | undefined;
  const codexTexts: string[] = [];
  let sawStructuredEvent = false;
  for (const line of lines) {
    const event = tryJson(line);
    if (!event || typeof event !== "object") continue;
    sawStructuredEvent = true;
    const sid = extractSessionIdFromStreamEvent(event);
    if (sid) sessionId = sid;
    const candidate = extractCodexAssistantMessage(event);
    if (candidate && codexTexts[codexTexts.length - 1] !== candidate) codexTexts.push(candidate);
  }
  const reply = codexTexts.join("\n\n") || (sawStructuredEvent ? "" : stdout.trim());
  return { reply: normalizeEscapedNewlines(reply.trim()), ...(sessionId !== undefined ? { sessionId } : {}) };
}
