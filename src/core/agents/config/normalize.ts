import { asRecord } from "../../infra/record.ts";
import type { EffortLevel } from "../../types.ts";
import { CAPABILITY_KEYS, capabilitiesForAdapter } from "./capabilities.ts";
import type {
  AgentCliConfig,
  AgentConfigBundle,
  AgentToolConfig,
  ExternalMcpInjection,
  ModelPoolConfig,
  ModelTier,
  PromptInputFormat,
  PromptTransport,
  QuotaPeriod,
  RoutingProfileConfig,
  RunnerAdapter,
  UsagePolicy,
  UsagePolicyKind,
  UsageSource
} from "./types.ts";

const VALID_ADAPTERS = new Set<RunnerAdapter>(["codex", "claude", "grok", "opencode", "acp", "generic"]);
const VALID_PROMPT_TRANSPORTS = new Set<PromptTransport>(["stdin", "argv", "file"]);
const VALID_PROMPT_INPUT_FORMATS = new Set<PromptInputFormat>(["text", "stream-json"]);
const VALID_EXTERNAL_MCP_INJECTIONS = new Set(["claude-mcp-json", "acp-merge", "opencode-env-content"]);
const VALID_USAGE_KINDS = new Set<UsagePolicyKind>(["quota", "usage-only", "unavailable"]);
const VALID_USAGE_SOURCES = new Set<UsageSource>(["codex-app-server", "claude-oauth", "none"]);
const VALID_PERIODS = new Set<QuotaPeriod>(["daily", "weekly", "monthly"]);
const VALID_TIERS = new Set<ModelTier>(["free", "paid"]);
const VALID_EFFORT_LEVELS = new Set<EffortLevel>(["low", "medium", "high", "xhigh", "max"]);

const DEFAULT_SOFT_THRESHOLD = 80;

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => str(entry)).filter((entry): entry is string => Boolean(entry));
}

function identifier(value: unknown, label: string): string {
  const id = str(value);
  if (!id) throw new Error(`${label} is required.`);
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) {
    throw new Error(`${label} "${id}" must be alphanumeric with . _ - separators.`);
  }
  return id;
}

export function normalizeUsagePolicy(raw: unknown, label: string): UsagePolicy {
  const record = asRecord(raw, `${label} usage`, { orNull: true });
  if (!record) return { kind: "usage-only", softThresholdPercent: DEFAULT_SOFT_THRESHOLD };

  const kind = (str(record["kind"]) ?? "usage-only") as UsagePolicyKind;
  if (!VALID_USAGE_KINDS.has(kind)) {
    throw new Error(`${label} usage.kind must be quota, usage-only, or unavailable.`);
  }

  if (kind === "unavailable") {
    return { kind: "unavailable" };
  }

  const used = record["used"] === undefined ? undefined : Number(record["used"]);
  if (used !== undefined && (!Number.isFinite(used) || used < 0)) {
    throw new Error(`${label} usage.used must be a non-negative number.`);
  }

  const softRaw = Number(record["softThresholdPercent"] ?? DEFAULT_SOFT_THRESHOLD);
  if (!Number.isFinite(softRaw) || softRaw < 50 || softRaw > 99) {
    throw new Error(`${label} usage.softThresholdPercent must be between 50 and 99.`);
  }
  const softThresholdPercent = Math.floor(softRaw);

  if (kind === "usage-only") {
    return { kind, softThresholdPercent, ...(used !== undefined ? { used } : {}) };
  }

  // kind === "quota"
  const period = (str(record["period"]) ?? "weekly") as QuotaPeriod;
  if (!VALID_PERIODS.has(period)) {
    throw new Error(`${label} usage.period must be daily, weekly, or monthly.`);
  }
  const limit = record["limit"] === undefined ? undefined : Number(record["limit"]);
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
    throw new Error(`${label} usage.limit must be a positive number when kind is quota.`);
  }
  return { kind, period, limit, softThresholdPercent, ...(used !== undefined ? { used } : {}) };
}

function normalizeEffortLevels(value: unknown, label: string): EffortLevel[] {
  const levels = stringArray(value);
  for (const level of levels) {
    if (!VALID_EFFORT_LEVELS.has(level as EffortLevel)) {
      throw new Error(`${label} has invalid effort level "${level}".`);
    }
  }
  return levels as EffortLevel[];
}

function normalizeCliConfig(raw: unknown): AgentCliConfig {
  const record = asRecord(raw, "cli", { orNull: true });
  if (!record) return {};
  const config: AgentCliConfig = {
    promptAsArg: record["promptAsArg"] === true,
    alwaysApproveInExecute: record["alwaysApproveInExecute"] === true
  };
  const outputFormat = str(record["outputFormat"]);
  if (outputFormat) config.outputFormat = outputFormat;
  const effortFlag = str(record["effortFlag"]);
  if (effortFlag) config.effortFlag = effortFlag;
  const effortConfigKey = str(record["effortConfigKey"]);
  if (effortConfigKey) config.effortConfigKey = effortConfigKey;
  const modes = asRecord(record["permissionModes"], "cli.permissionModes", { orNull: true });
  if (modes) {
    const plan = str(modes["plan"]);
    const execute = str(modes["execute"]);
    if (plan || execute) {
      config.permissionModes = {
        ...(plan !== undefined ? { plan } : {}),
        ...(execute !== undefined ? { execute } : {})
      };
    }
  }
  for (const key of CAPABILITY_KEYS) {
    if (typeof record[key] === "boolean") config[key] = record[key] as boolean;
  }
  return config;
}

function stringRecord(raw: unknown, label: string): Record<string, string> {
  const record = asRecord(raw, label, { orNull: true });
  if (!record) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    const v = str(value);
    if (v) out[key] = v;
  }
  return out;
}

function normalizeAuthProbe(raw: unknown, label: string): AgentToolConfig["authProbe"] {
  const record = asRecord(raw, `${label} authProbe`, { orNull: true });
  if (!record) return undefined;
  if (!Array.isArray(record["args"])) throw new Error(`${label} authProbe.args must be an array of strings.`);
  const args = stringArray(record["args"]);
  if (args.length === 0) throw new Error(`${label} authProbe.args must not be empty.`);
  const timeoutRaw = record["timeoutMs"] === undefined ? undefined : Number(record["timeoutMs"]);
  if (timeoutRaw !== undefined && (!Number.isFinite(timeoutRaw) || timeoutRaw <= 0)) {
    throw new Error(`${label} authProbe.timeoutMs must be a positive number.`);
  }
  return { args, ...(timeoutRaw !== undefined ? { timeoutMs: Math.floor(timeoutRaw) } : {}) };
}

function commandString(value: unknown, label: string): string {
  const command = str(value);
  if (!command) throw new Error(`${label} is required.`);
  return command;
}

/** Fill any absent live-capability flags from the adapter's defaults. */
function withCapabilityDefaults(adapter: RunnerAdapter, cli: AgentCliConfig): AgentCliConfig {
  const defaults = capabilitiesForAdapter(adapter);
  const result: AgentCliConfig = { ...cli };
  for (const key of CAPABILITY_KEYS) {
    if (result[key] === undefined) result[key] = defaults[key];
  }
  return result;
}

export function normalizeTool(raw: unknown): AgentToolConfig {
  const record = asRecord(raw, "tool")!;
  const id = identifier(record["id"], "tool.id");
  const label = `tool "${id}"`;
  const adapter = (str(record["adapter"]) ?? "generic") as RunnerAdapter;
  if (!VALID_ADAPTERS.has(adapter)) {
    throw new Error(`tool "${id}" adapter must be codex, claude, grok, opencode, acp, or generic.`);
  }
  const effortLevels = normalizeEffortLevels(record["effortLevels"], `tool "${id}"`);
  const supportsEffort =
    record["supportsEffort"] === true
      ? true
      : record["supportsEffort"] === false
        ? false
        : effortLevels.length > 0;
  if (supportsEffort && effortLevels.length === 0) {
    throw new Error(`tool "${id}" supports effort but declares no effortLevels.`);
  }
  const commandTemplate = stringArray(record["commandTemplate"]);
  const authProbe = normalizeAuthProbe(record["authProbe"], label);
  const transport = (str(record["promptTransport"]) ??
    (record["cli"] && asRecord(record["cli"], "cli", { orNull: true })?.["promptAsArg"] === true ? "argv" : "stdin")) as PromptTransport;
  if (!VALID_PROMPT_TRANSPORTS.has(transport)) {
    throw new Error(`${label} promptTransport must be stdin, argv, or file.`);
  }
  const inputFormat = str(record["promptInputFormat"]) as PromptInputFormat | undefined;
  if (inputFormat && !VALID_PROMPT_INPUT_FORMATS.has(inputFormat)) {
    throw new Error(`${label} promptInputFormat must be text or stream-json.`);
  }
  const maxPromptArgBytes =
    record["maxPromptArgBytes"] === undefined ? undefined : Number(record["maxPromptArgBytes"]);
  if (maxPromptArgBytes !== undefined && (!Number.isFinite(maxPromptArgBytes) || maxPromptArgBytes <= 0)) {
    throw new Error(`${label} maxPromptArgBytes must be a positive number.`);
  }
  const inactivityTimeoutMs =
    record["inactivityTimeoutMs"] === undefined ? undefined : Number(record["inactivityTimeoutMs"]);
  if (
    inactivityTimeoutMs !== undefined &&
    (!Number.isFinite(inactivityTimeoutMs) || inactivityTimeoutMs < 0 || !Number.isInteger(inactivityTimeoutMs))
  ) {
    throw new Error(`${label} inactivityTimeoutMs must be a non-negative integer.`);
  }
  const externalMcpInjectionRaw = str(record["externalMcpInjection"]);
  let externalMcpInjection: ExternalMcpInjection | undefined;
  if (externalMcpInjectionRaw && VALID_EXTERNAL_MCP_INJECTIONS.has(externalMcpInjectionRaw)) {
    externalMcpInjection = externalMcpInjectionRaw as ExternalMcpInjection;
  }
  if (externalMcpInjectionRaw && !externalMcpInjection) {
    throw new Error(`${label} externalMcpInjection is invalid.`);
  }
  const streamFormat = str(record["streamFormat"]);
  const eventParser = str(record["eventParser"]);
  return {
    id,
    displayName: str(record["displayName"]) ?? id,
    command: commandString(record["command"] ?? id, `tool "${id}" command`),
    adapter,
    enabled: record["enabled"] === undefined ? true : Boolean(record["enabled"]),
    builtin: record["builtin"] === true,
    supportsEffort,
    effortLevels,
    cli: withCapabilityDefaults(adapter, normalizeCliConfig(record["cli"])),
    usage: normalizeUsagePolicy(record["usage"], `tool "${id}"`),
    ...(commandTemplate.length ? { commandTemplate } : {}),
    promptTransport: transport,
    ...(inputFormat !== undefined ? { promptInputFormat: inputFormat } : {}),
    ...(maxPromptArgBytes !== undefined ? { maxPromptArgBytes: Math.floor(maxPromptArgBytes) } : {}),
    fallbackCommands: stringArray(record["fallbackCommands"]),
    versionArgs: stringArray(record["versionArgs"]),
    helpArgs: stringArray(record["helpArgs"]),
    capabilityFlags: stringRecord(record["capabilityFlags"], `${label} capabilityFlags`),
    ...(authProbe !== undefined ? { authProbe } : {}),
    ...(streamFormat !== undefined ? { streamFormat } : {}),
    ...(eventParser !== undefined ? { eventParser } : {}),
    ...(externalMcpInjection !== undefined ? { externalMcpInjection } : {}),
    supportsCustomModel: record["supportsCustomModel"] === undefined ? true : Boolean(record["supportsCustomModel"]),
    ...(inactivityTimeoutMs !== undefined ? { inactivityTimeoutMs } : {}),
    resumesSessionViaCli: record["resumesSessionViaCli"] === true
  };
}

function normalizeModelEnv(raw: unknown, label: string): Record<string, string> {
  const record = asRecord(raw, `${label} modelEnv`, { orNull: true });
  if (!record) return {};
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    const v = str(value);
    if (v) env[key] = v;
  }
  return env;
}

export function normalizeModelPool(raw: unknown): ModelPoolConfig {
  const record = asRecord(raw, "modelPool")!;
  const id = identifier(record["id"], "modelPool.id");
  const toolId = identifier(record["toolId"], `modelPool "${id}" toolId`);
  const qualityRaw = Number(record["qualityWeight"] ?? 50);
  if (!Number.isFinite(qualityRaw) || qualityRaw < 0 || qualityRaw > 100) {
    throw new Error(`modelPool "${id}" qualityWeight must be between 0 and 100.`);
  }
  const tier = (str(record["tier"]) ?? "paid") as ModelTier;
  if (!VALID_TIERS.has(tier)) {
    throw new Error(`modelPool "${id}" tier must be free or paid.`);
  }
  const usageSource = (str(record["usageSource"]) ?? "none") as UsageSource;
  if (!VALID_USAGE_SOURCES.has(usageSource)) {
    throw new Error(`modelPool "${id}" usageSource must be codex-app-server, claude-oauth, or none.`);
  }
  return {
    id,
    toolId,
    displayName: str(record["displayName"]) ?? id,
    modelArgs: stringArray(record["modelArgs"]),
    modelEnv: normalizeModelEnv(record["modelEnv"], `modelPool "${id}"`),
    capabilities: stringArray(record["capabilities"]),
    qualityWeight: Math.floor(qualityRaw),
    tier,
    usage: normalizeUsagePolicy(record["usage"], `modelPool "${id}"`),
    usageSource,
    enabled: record["enabled"] === undefined ? true : Boolean(record["enabled"]),
    builtin: record["builtin"] === true
  };
}

export function normalizeRoutingProfile(raw: unknown): RoutingProfileConfig {
  const record = asRecord(raw, "routingProfile")!;
  const role = identifier(record["role"], "routingProfile.role");
  const minRaw = Number(record["minQuality"] ?? 0);
  if (!Number.isFinite(minRaw) || minRaw < 0 || minRaw > 100) {
    throw new Error(`routingProfile "${role}" minQuality must be between 0 and 100.`);
  }
  const requiredCapability = str(record["requiredCapability"]);
  const preferToolIds = stringArray(record["preferToolIds"]);
  return {
    role,
    minQuality: Math.floor(minRaw),
    ...(requiredCapability !== undefined ? { requiredCapability } : {}),
    ...(preferToolIds.length ? { preferToolIds } : {})
  };
}

/** Validate cross-references and uniqueness across the whole bundle. */
export function normalizeBundle(raw: {
  tools?: unknown;
  pools?: unknown;
  profiles?: unknown;
}): AgentConfigBundle {
  const tools = (Array.isArray(raw.tools) ? raw.tools : []).map(normalizeTool);
  const pools = (Array.isArray(raw.pools) ? raw.pools : []).map(normalizeModelPool);
  const profiles = (Array.isArray(raw.profiles) ? raw.profiles : []).map(normalizeRoutingProfile);

  assertUnique(tools.map((tool) => tool.id), "tool id");
  assertUnique(pools.map((pool) => pool.id), "model pool id");
  assertUnique(profiles.map((profile) => profile.role), "routing profile role");

  const toolIds = new Set(tools.map((tool) => tool.id));
  for (const pool of pools) {
    if (!toolIds.has(pool.toolId)) {
      throw new Error(`model pool "${pool.id}" references unknown tool "${pool.toolId}".`);
    }
  }
  return { tools, pools, profiles };
}

function assertUnique(values: string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`Duplicate ${label} "${value}".`);
    seen.add(value);
  }
}
