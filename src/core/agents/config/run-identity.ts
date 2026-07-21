import type { ModelPoolId, ToolId } from "../../types.ts";
import type { ResolvedModelIdentity } from "../identity-types.ts";
import { resolveLaunchByIds } from "./launch.ts";
import { resolveRunModelIdentity } from "./model-identity.ts";

/** Resolve and freeze model identity for a routed tool + pool pair. */
export async function resolveRunIdentityFromRouting(
  root: string,
  toolId: ToolId,
  modelPoolId: ModelPoolId
): Promise<ResolvedModelIdentity | undefined> {
  const launch = await resolveLaunchByIds(root, toolId, modelPoolId);
  if (!launch) return undefined;
  return resolveRunModelIdentity(launch.tool, launch.pool);
}
