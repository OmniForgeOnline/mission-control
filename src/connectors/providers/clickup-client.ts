type FetchLike = typeof fetch;

/** The sole origin the operator ClickUp token may be sent to. Attachment
 * download URLs returned by ClickUp are typically signed/public links on other
 * hosts (CDNs, app domains) and must never receive the bearer token. */
const CLICKUP_API_ORIGIN = "https://api.clickup.com";

/**
 * True only when `rawUrl` is on the ClickUp REST API origin (`https://api.clickup.com`).
 * Used to gate attachment downloads: the token is attached solely for verified API
 * origins and withheld from every other host, signed/public link, malformed value,
 * plain-http URL, or look-alike (`api.clickup.com.evil.com`). Never throws.
 */
export function isClickUpApiUrl(rawUrl: string): boolean {
  try {
    return new URL(rawUrl).origin === CLICKUP_API_ORIGIN;
  } catch {
    return false;
  }
}

export interface ClickUpTaskSummary {
  id: string;
  name: string;
  markdown_description?: string;
  text_content?: string;
  description?: string;
  date_updated?: string;
  url?: string;
  status?: { status?: string } | string;
}

export interface ClickUpTaskComment {
  id: string;
  text: string;
  date: string;
  authorId?: string;
}

export class ClickUpRateLimitError extends Error {
  constructor(message = "ClickUp API rate limited the sync request.") {
    super(message);
    this.name = "ClickUpRateLimitError";
  }
}

export class ClickUpApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string
  ) {
    super(message);
    this.name = "ClickUpApiError";
  }
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: token };
}

function jsonHeaders(token: string): Record<string, string> {
  return { ...authHeaders(token), "Content-Type": "application/json" };
}

/** Transient transport failures worth retrying: socket read/write timeouts
 * (the reported `read ETIMEDOUT` / errno -60 case), connection resets, DNS
 * hiccups, and undici's own timeout/socket errors. Durable conditions such as
 * a wrong host (ENOTFOUND) are deliberately excluded. */
const TRANSIENT_NETWORK_CODES = new Set([
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT"
]);

export interface ClickUpRetryOptions {
  /** Total attempts including the first. Default 4. */
  maxAttempts?: number;
  /** Base backoff in ms; retries wait base * 2^attempt (capped). Default 400.
   * Tests pass 0 so retries resolve without real sleeps. */
  baseDelayMs?: number;
}

const DEFAULT_CLICKUP_RETRY: Required<ClickUpRetryOptions> = {
  maxAttempts: 4,
  baseDelayMs: 400
};

const CLICKUP_BACKOFF_CAP_MS = 4_000;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Walk an error's `.cause` chain (undici wraps the real system error there) and
 * return the deepest Error, so callers can read its `code`/`syscall`/message. */
function deepestError(error: unknown): Error | undefined {
  let deepest: Error | undefined;
  let candidate: unknown = error;
  for (let depth = 0; depth < 5 && candidate; depth += 1) {
    if (candidate instanceof Error) deepest = candidate;
    candidate = (candidate as { cause?: unknown } | null)?.cause;
  }
  return deepest;
}

/** True when `error` is a retryable transient transport failure. Undici surfaces
 * socket timeouts as `TypeError: fetch failed` whose `.cause` carries the Node
 * system error with the matching `code`; this walks that chain. AbortError
 * covers request timeouts signalled via AbortController. */
export function isTransientNetworkError(error: unknown): boolean {
  let candidate: unknown = error;
  for (let depth = 0; depth < 5 && candidate; depth += 1) {
    if (candidate instanceof Error) {
      const code = (candidate as NodeJS.ErrnoException).code;
      if (typeof code === "string" && TRANSIENT_NETWORK_CODES.has(code)) return true;
      if (candidate.name === "AbortError") return true;
    }
    candidate = (candidate as { cause?: unknown } | null)?.cause;
  }
  return false;
}

/** Compact root-cause label for logs: `ETIMEDOUT read`, falling back to the
 * error name/message when no errno is present. */
export function describeNetworkError(error: unknown): string {
  const deepest = deepestError(error);
  if (!deepest) return String(error);
  const code = (deepest as NodeJS.ErrnoException).code;
  const syscall = (deepest as { syscall?: string }).syscall;
  return [code, syscall].filter(Boolean).join(" ") || `${deepest.name}: ${deepest.message}`;
}

/** Run a single idempotent ClickUp request, retrying only transient transport
 * failures with bounded exponential backoff. HTTP responses (4xx/5xx, 429) are
 * returned to the caller untouched, so rate-limit and auth handling in
 * `readJsonResponse` is unchanged.
 *
 * Idempotent-only: a read timeout can land after the server has applied the
 * request but before the response arrives, so retrying a non-idempotent write
 * (e.g. the comment POST) would duplicate its side effect. Use this wrapper for
 * GET reads and idempotent PUTs; route any create/non-idempotent write through
 * `fetchImpl` directly so it stays single-attempt. */
async function requestClickUp(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  retry?: ClickUpRetryOptions
): Promise<Response> {
  const maxAttempts = Math.max(1, retry?.maxAttempts ?? DEFAULT_CLICKUP_RETRY.maxAttempts);
  const baseDelayMs = retry?.baseDelayMs ?? DEFAULT_CLICKUP_RETRY.baseDelayMs;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await fetchImpl(url, init);
    } catch (error) {
      const exhausted = attempt + 1 >= maxAttempts;
      if (exhausted || !isTransientNetworkError(error)) {
        throw error;
      }
      await sleep(Math.min(baseDelayMs * 2 ** attempt, CLICKUP_BACKOFF_CAP_MS));
    }
  }
  // Unreachable: the loop returns on success or throws on the final attempt.
  throw new Error("ClickUp request retry loop exited without a response.");
}

async function readJsonResponse<T>(response: Response, action: string): Promise<T> {
  if (response.status === 429) {
    throw new ClickUpRateLimitError();
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const detail = body ? `: ${body.slice(0, 500)}` : "";
    throw new ClickUpApiError(`${action} failed with status ${response.status}${detail}`, response.status, body);
  }
  return (await response.json()) as T;
}

export async function listClickUpTasks(options: {
  token: string;
  listId: string;
  dateUpdatedGt?: string;
  fetchImpl?: FetchLike;
  retry?: ClickUpRetryOptions;
}): Promise<ClickUpTaskSummary[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const tasks: ClickUpTaskSummary[] = [];
  for (let page = 0; ; page += 1) {
    const params = new URLSearchParams({
      archived: "false",
      include_markdown_description: "true",
      order_by: "updated",
      reverse: "true",
      page: String(page)
    });
    if (options.dateUpdatedGt) {
      params.set("date_updated_gt", options.dateUpdatedGt);
    }
    const response = await requestClickUp(
      fetchImpl,
      `https://api.clickup.com/api/v2/list/${options.listId}/task?${params}`,
      { headers: authHeaders(options.token) },
      options.retry
    );
    const data = await readJsonResponse<{ tasks?: ClickUpTaskSummary[] }>(response, "ClickUp task list");
    const pageTasks = data.tasks ?? [];
    tasks.push(...pageTasks);
    if (pageTasks.length < 100) break;
  }
  return tasks;
}

export async function listClickUpTaskComments(options: {
  token: string;
  taskId: string;
  fetchImpl?: FetchLike;
  retry?: ClickUpRetryOptions;
}): Promise<ClickUpTaskComment[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await requestClickUp(
    fetchImpl,
    `https://api.clickup.com/api/v2/task/${options.taskId}/comment`,
    { headers: authHeaders(options.token) },
    options.retry
  );
  const data = await readJsonResponse<{ comments?: Array<Record<string, unknown>> }>(
    response,
    "ClickUp comments lookup"
  );
  return (data.comments ?? []).map((comment) => ({
    id: String(comment["id"] ?? ""),
    text: String(comment["comment_text"] ?? comment["text"] ?? ""),
    date: String(comment["date"] ?? comment["date_updated"] ?? "0"),
    authorId: String((comment["user"] as { id?: string | number } | undefined)?.id ?? comment["user_id"] ?? "")
  }));
}

export interface ClickUpAttachment {
  id: string;
  /** Original filename, when ClickUp provides one. */
  title: string;
  /** Downloadable attachment URL (may be a signed/public link). */
  url: string;
  date?: string;
  extension?: string;
  mimeType?: string;
}

export async function listClickUpTaskAttachments(options: {
  token: string;
  taskId: string;
  fetchImpl?: FetchLike;
  retry?: ClickUpRetryOptions;
}): Promise<ClickUpAttachment[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  // ClickUp's v2 API has no GET list-attachments endpoint: /task/{id}/attachment
  // is POST-only (Create Task Attachment). Attachments ride on the Get Task
  // response, so read them from there.
  const response = await requestClickUp(
    fetchImpl,
    `https://api.clickup.com/api/v2/task/${options.taskId}`,
    { headers: authHeaders(options.token) },
    options.retry
  );
  const data = await readJsonResponse<{ attachments?: Array<Record<string, unknown>> }>(
    response,
    "ClickUp task detail"
  );
  return (data.attachments ?? []).map((attachment) => {
    const mapped: ClickUpAttachment = {
      id: String(attachment["id"] ?? ""),
      title: String(attachment["title"] ?? attachment["filename"] ?? ""),
      url: String(attachment["url"] ?? "")
    };
    if (attachment["date"] != null) mapped.date = String(attachment["date"]);
    if (attachment["extension"] != null) mapped.extension = String(attachment["extension"]);
    const mime = attachment["mime_type"] ?? attachment["mimeType"] ?? attachment["type"];
    if (typeof mime === "string") mapped.mimeType = mime;
    return mapped;
  });
}

export async function updateClickUpTaskStatus(options: {
  token: string;
  taskId: string;
  status: string;
  fetchImpl?: FetchLike;
  retry?: ClickUpRetryOptions;
}): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await requestClickUp(
    fetchImpl,
    `https://api.clickup.com/api/v2/task/${options.taskId}`,
    { method: "PUT", headers: jsonHeaders(options.token), body: JSON.stringify({ status: options.status }) },
    options.retry
  );
  await readJsonResponse<unknown>(response, "ClickUp status update");
}

export async function createClickUpComment(options: {
  token: string;
  taskId: string;
  text: string;
  fetchImpl?: FetchLike;
}): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  // Single-attempt on purpose: comment creation is a non-idempotent POST. A read
  // timeout can arrive after ClickUp has already recorded the comment, so a retry
  // would post it twice. The job is self-healing across polling intervals; a
  // transient failure here surfaces and the next tick re-evaluates the task.
  const response = await fetchImpl(
    `https://api.clickup.com/api/v2/task/${options.taskId}/comment`,
    { method: "POST", headers: jsonHeaders(options.token), body: JSON.stringify({ comment_text: options.text }) }
  );
  await readJsonResponse<unknown>(response, "ClickUp comment create");
}
