import { createHash } from "node:crypto";

export function hashBody(body: string): string {
  return createHash("sha256").update(body.trim()).digest("hex");
}
