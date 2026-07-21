const SECRET_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+\b/g,
  /\bsk-[A-Za-z0-9]{10,}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bgho_[A-Za-z0-9]{20,}\b/g,
  /\bglpat-[A-Za-z0-9._-]{10,}\b/g,
  /\bpk_(live|test)_[A-Za-z0-9]+\b/g,
  /"(?:accessToken|access_token|refreshToken|refresh_token|clientSecret|client_secret|apiKey|api_key|token)"\s*:\s*"[^"]+"/gi
];

const SECRET_FLAG_TOKENS = new Set([
  "--api-key",
  "--token",
  "--access-token",
  "--refresh-token",
  "-H",
  "--header"
]);

const SECRET_FLAG_NAMES = /^(?:--api[-_]key|--token|--access[-_]token|--refresh[-_]token)$/i;

function redactSecretFlagToken(token: string): string | null {
  const equals = token.match(/^(--api[-_]key|--token|--access[-_]token|--refresh[-_]token)=(.*)$/i);
  return equals ? `${equals[1]}=[REDACTED]` : null;
}

function redactSecretFlagsInArray(items: string[]): string[] {
  const next = [...items];
  for (let index = 0; index < next.length; index += 1) {
    const token = next[index]?.trim();
    if (!token) continue;
    const inline = redactSecretFlagToken(token);
    if (inline) {
      next[index] = inline;
      continue;
    }
    if ((token.toLowerCase() === "-h" || token.toLowerCase() === "--header") && index + 1 < next.length) {
      const header = next[index + 1] ?? "";
      if (/^(?:authorization|proxy-authorization|x-api-key|x-auth-token):/i.test(header)) {
        next[index + 1] = "Authorization: [REDACTED]";
      }
      continue;
    }
    if (!SECRET_FLAG_TOKENS.has(token.toLowerCase()) && !SECRET_FLAG_NAMES.test(token)) continue;
    if (index + 1 < next.length) {
      next[index + 1] = "[REDACTED]";
    }
  }
  return next;
}

function redactStructuredSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    const asStrings = value.every((entry) => typeof entry === "string");
    const mapped = asStrings
      ? redactSecretFlagsInArray(value as string[])
      : value.map((entry) => redactStructuredSecrets(entry));
    return mapped;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) {
      if (key === "modelEnv" && entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
        const env: Record<string, unknown> = {};
        for (const [envKey, envValue] of Object.entries(entry as Record<string, unknown>)) {
          env[envKey] = typeof envValue === "string" ? "[REDACTED]" : redactStructuredSecrets(envValue);
        }
        next[key] = env;
        continue;
      }
      if (key === "modelArgs" && Array.isArray(entry) && entry.every((item) => typeof item === "string")) {
        next[key] = redactSecretFlagsInArray(entry as string[]);
        continue;
      }
      next[key] = redactStructuredSecrets(entry);
    }
    return next;
  }
  return value;
}

export function redactSecrets(value: string): string {
  let next = value;
  for (const pattern of SECRET_PATTERNS) {
    next = next.replace(pattern, "[REDACTED]");
  }
  return next;
}

export function redactValue<T>(value: T): T {
  const structured = redactStructuredSecrets(value);
  return JSON.parse(redactSecrets(JSON.stringify(structured))) as T;
}
