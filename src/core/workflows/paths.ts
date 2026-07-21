import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT =
  process.env["HARNESS_PACKAGE_ROOT"] ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export function bundledWorkflowsDir(): string {
  return path.join(PACKAGE_ROOT, "workflows");
}

export function workflowsDir(root: string): string {
  return path.join(root, "workflows");
}
