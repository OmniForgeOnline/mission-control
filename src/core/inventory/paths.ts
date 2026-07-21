import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT =
  process.env["HARNESS_PACKAGE_ROOT"] ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export function packageRoot(): string {
  return PACKAGE_ROOT;
}

export function bundledSkillsDir(): string {
  return path.join(PACKAGE_ROOT, "skills");
}
