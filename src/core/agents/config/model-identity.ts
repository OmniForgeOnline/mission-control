import type { ToolId } from "../../types.ts";
import type {
  ModelPoolIdentity,
  ModelProviderId,
  ResolvedModelIdentity,
  VerificationState
} from "../identity-types.ts";
import type { AgentToolConfig, ModelPoolConfig } from "./types.ts";

const VALID_PROVIDERS = new Set<ModelProviderId>([
  "anthropic",
  "openai",
  "grok",
  "glm",
  "composer",
  "cursor",
  "local",
  "unknown"
]);
const VALID_VERIFICATION = new Set<VerificationState>(["verified", "unverified", "unknown"]);

const NATIVE_TOOL_PROVIDERS: Record<string, ModelProviderId[]> = {
  claude: ["anthropic"],
  codex: ["openai"],
  grok: ["grok"],
  cursor: ["composer", "cursor", "anthropic", "openai"],
  kiro: ["anthropic"],
  opencode: ["unknown", "local", "openai", "anthropic", "glm"],
  ollama: ["local"]
};

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Model id from launch args (e.g. `--model glm-5.2`) or `(default)` when unset. */
export function extractConfiguredModel(modelArgs: string[]): string {
  const idx = modelArgs.indexOf("--model");
  if (idx >= 0 && typeof modelArgs[idx + 1] === "string" && modelArgs[idx + 1]!.trim()) {
    return modelArgs[idx + 1]!.trim();
  }
  if (modelArgs.length === 0) return "(default)";
  return modelArgs.join(" ");
}

/** Infer the underlying provider family from a model id string. */
export function inferProviderFromModel(modelId: string): ModelProviderId | null {
  const id = modelId.toLowerCase();
  if (id === "(default)") return null;
  if (/^grok-/.test(id)) return "grok";
  if (/^composer-/.test(id) || id.includes("composer")) return "composer";
  if (/^claude-/.test(id) || id.includes("fable")) return "anthropic";
  if (/^gpt-/.test(id) || /^o[134]-/.test(id) || id.includes("codex")) return "openai";
  if (/^glm-/.test(id)) return "glm";
  if (id === "auto" || /^cursor-/.test(id)) return "cursor";
  if (/^(llama|mistral|qwen|ollama)/.test(id)) return "local";
  return null;
}

export function nativeProviderForTool(tool: AgentToolConfig): ModelProviderId {
  switch (tool.adapter) {
    case "codex":
      return "openai";
    case "claude":
      return "anthropic";
    case "grok":
      return "grok";
    case "acp":
      if (tool.id === "cursor") return "cursor";
      if (tool.id === "kiro") return "anthropic";
      return "unknown";
    case "opencode":
      return "unknown";
    case "generic":
      return "local";
    default:
      return "unknown";
  }
}

function glmEndpointProof(modelEnv: Record<string, string>): string | undefined {
  const base = modelEnv["ANTHROPIC_BASE_URL"] ?? modelEnv["OPENAI_BASE_URL"] ?? "";
  if (/glm|z\.ai|bigmodel/i.test(base)) return base;
  return undefined;
}

function nativeProvidersForTool(toolId: ToolId): ModelProviderId[] {
  return NATIVE_TOOL_PROVIDERS[toolId] ?? [nativeProviderForTool({ id: toolId } as AgentToolConfig)];
}

function isNativeOwnership(toolId: ToolId, provider: ModelProviderId, endpointProof?: string): boolean {
  if (provider === "glm" && endpointProof) return true;
  return nativeProvidersForTool(toolId).includes(provider);
}

function deriveVerificationState(
  tool: AgentToolConfig,
  provider: ModelProviderId,
  configuredModel: string,
  endpointProof?: string,
  explicit?: VerificationState
): VerificationState {
  if (explicit && explicit !== "unknown") return explicit;
  if (configuredModel === "(default)") return "unknown";
  const inferred = inferProviderFromModel(configuredModel);
  if (inferred && inferred === provider && isNativeOwnership(tool.id, provider, endpointProof)) {
    return "verified";
  }
  if (endpointProof && provider === "glm") return "verified";
  if (inferred && inferred !== provider && !endpointProof) return "unverified";
  if (!inferred) return explicit ?? "unknown";
  return isNativeOwnership(tool.id, provider, endpointProof) ? "verified" : "unverified";
}

export function normalizeModelPoolIdentity(
  raw: unknown,
  toolId: ToolId,
  modelArgs: string[],
  modelEnv: Record<string, string>,
  label: string
): ModelPoolIdentity {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const configuredModel = str(record["configuredModel"]) ?? extractConfiguredModel(modelArgs);
  const endpointProof = str(record["endpointProof"]) ?? glmEndpointProof(modelEnv);
  const providerRaw = (str(record["provider"]) ?? inferProviderFromModel(configuredModel) ?? "unknown") as ModelProviderId;
  if (!VALID_PROVIDERS.has(providerRaw)) {
    throw new Error(`${label} identity.provider "${providerRaw}" is invalid.`);
  }
  const verificationRaw = (str(record["verificationState"]) ?? "unknown") as VerificationState;
  if (!VALID_VERIFICATION.has(verificationRaw)) {
    throw new Error(`${label} identity.verificationState must be verified, unverified, or unknown.`);
  }
  const provider =
    configuredModel === "(default)" && providerRaw === "unknown"
      ? nativeProviderForTool({ id: toolId } as AgentToolConfig)
      : providerRaw;
  const verificationState = deriveVerificationState(
    { id: toolId } as AgentToolConfig,
    provider,
    configuredModel,
    endpointProof,
    verificationRaw
  );
  return {
    provider,
    configuredModel,
    verificationState,
    ...(endpointProof ? { endpointProof } : {})
  };
}

export function finalizePoolIdentity(tool: AgentToolConfig, pool: ModelPoolConfig): ModelPoolConfig {
  const configuredModel = extractConfiguredModel(pool.modelArgs);
  const endpointProof = pool.identity?.endpointProof ?? glmEndpointProof(pool.modelEnv);
  const inferred = inferProviderFromModel(configuredModel);
  const provider =
    pool.identity?.provider && pool.identity.provider !== "unknown"
      ? pool.identity.provider
      : inferred ?? nativeProviderForTool(tool);
  const verificationState = deriveVerificationState(
    tool,
    provider,
    configuredModel,
    endpointProof,
    pool.identity?.verificationState
  );
  const identity: ModelPoolIdentity = {
    provider,
    configuredModel,
    verificationState,
    ...(endpointProof ? { endpointProof } : {})
  };
  return { ...pool, identity };
}

/** Label shown for harness-default pools (no explicit --model arg). */
export function resolveHarnessDefaultModelLabel(tool: AgentToolConfig): string {
  const provider = nativeProviderForTool(tool);
  return `${provider}/harness-default`;
}

/** Capture the resolved identity for a run. */
export function resolveRunModelIdentity(tool: AgentToolConfig, pool: ModelPoolConfig): ResolvedModelIdentity {
  const finalized = finalizePoolIdentity(tool, pool);
  if (!finalized.identity) {
    throw new Error(`model pool "${pool.id}" is missing normalized identity metadata.`);
  }
  const configuredModel = finalized.identity.configuredModel;
  const resolvedModel =
    configuredModel === "(default)" ? resolveHarnessDefaultModelLabel(tool) : configuredModel;
  return {
    harness: tool.id,
    provider: finalized.identity.provider,
    configuredModel,
    resolvedModel,
    verificationState: finalized.identity.verificationState
  };
}
