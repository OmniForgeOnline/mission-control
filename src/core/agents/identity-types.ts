import type { ToolId } from "../types.ts";

/** Underlying model vendor (distinct from the CLI harness tool). */
export type ModelProviderId =
  | "anthropic"
  | "openai"
  | "grok"
  | "glm"
  | "composer"
  | "cursor"
  | "local"
  | "unknown";

export type VerificationState = "verified" | "unverified" | "unknown";

export interface ModelPoolIdentity {
  provider: ModelProviderId;
  configuredModel: string;
  verificationState: VerificationState;
  /** Compatible endpoint proof for proxied providers (e.g. GLM base URL). */
  endpointProof?: string;
}

/** Identity captured at run start for routing transparency. */
export interface ResolvedModelIdentity {
  harness: ToolId;
  provider: ModelProviderId;
  configuredModel: string;
  resolvedModel: string;
  verificationState: VerificationState;
}
