import path from "node:path";

import { packageRoot } from "../inventory/paths.ts";

export { packageRoot } from "../inventory/paths.ts";

export function bundledEvalCorpusDir(version = "v1"): string {
  return path.join(packageRoot(), "tests", "evals", "cases", version);
}
