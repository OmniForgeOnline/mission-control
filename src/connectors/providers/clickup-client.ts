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
    const response = await fetchImpl(`https://api.clickup.com/api/v2/list/${options.listId}/task?${params}`, {
      headers: authHeaders(options.token)
    });
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
}): Promise<ClickUpTaskComment[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`https://api.clickup.com/api/v2/task/${options.taskId}/comment`, {
    headers: authHeaders(options.token)
  });
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
}): Promise<ClickUpAttachment[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  // ClickUp's v2 API has no GET list-attachments endpoint: /task/{id}/attachment
  // is POST-only (Create Task Attachment). Attachments ride on the Get Task
  // response, so read them from there.
  const response = await fetchImpl(`https://api.clickup.com/api/v2/task/${options.taskId}`, {
    headers: authHeaders(options.token)
  });
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
}): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`https://api.clickup.com/api/v2/task/${options.taskId}`, {
    method: "PUT",
    headers: jsonHeaders(options.token),
    body: JSON.stringify({ status: options.status })
  });
  await readJsonResponse<unknown>(response, "ClickUp status update");
}

export async function createClickUpComment(options: {
  token: string;
  taskId: string;
  text: string;
  fetchImpl?: FetchLike;
}): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`https://api.clickup.com/api/v2/task/${options.taskId}/comment`, {
    method: "POST",
    headers: jsonHeaders(options.token),
    body: JSON.stringify({ comment_text: options.text })
  });
  await readJsonResponse<unknown>(response, "ClickUp comment create");
}
