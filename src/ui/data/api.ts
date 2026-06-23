export async function api<T = unknown>(path: string, options: RequestInit = {}): Promise<T | null> {
  let response: Response;
  try {
    response = await fetch(path, {
      headers: { "content-type": "application/json" },
      ...options
    });
  } catch (e) {
    throw new Error(`Network error calling ${path}: ${(e as Error).message}. Is the backend running on port 4827?`);
  }

  if (response.status === 204) return null;

  const text = await response.text();
  let data: unknown = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      // The server returned HTML (e.g. 404 page or Vite fallback) instead of JSON
      const snippet = text.slice(0, 100).replace(/\s+/g, " ");
      throw new Error(
        `Expected JSON from ${path} but got HTML (status ${response.status}). ` +
        `This usually means you are on the Vite dev server (5173) without the backend proxy active, ` +
        `or the route does not exist. Response started with: "${snippet}..."`
      );
    }
  }

  if (!response.ok) {
    const errorMessage =
      typeof data === "object" &&
      data !== null &&
      "error" in data &&
      typeof (data as { error?: unknown }).error === "string"
        ? (data as { error: string }).error
        : undefined;
    throw new Error(errorMessage || `Request to ${path} failed with status ${response.status}`);
  }

  return data as T;
}