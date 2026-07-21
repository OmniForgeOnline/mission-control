import { readFile } from "node:fs/promises";
import path from "node:path";

import { packageRoot } from "../inventory/paths.ts";
import type { EvalCase } from "./types.ts";

export const DEFAULT_CHECKS_WORKSPACE = "tests/evals/fixtures/checks-validated";

function isFixturePath(value: string): boolean {
  return value.includes("/") || value.endsWith(".md") || value.endsWith(".json") || value.endsWith(".txt");
}

export function resolveEvalFixturePath(relativePath: string): string {
  return path.join(packageRoot(), relativePath);
}

export async function loadReviewerReplyFixture(value: string): Promise<string> {
  if (!isFixturePath(value)) return value;
  return readFile(resolveEvalFixturePath(value), "utf8");
}

export function replayArtifactPaths(evalCase: EvalCase): string[] | undefined {
  const explicit = evalCase.replay?.fixtures?.artifactPaths;
  if (explicit?.length) return [...explicit];
  return undefined;
}

export function replayChecksWorkspacePath(evalCase: EvalCase): string | undefined {
  if (!evalCase.replay?.fixtures) return undefined;
  return evalCase.replay.fixtures.workspacePath ?? DEFAULT_CHECKS_WORKSPACE;
}

export async function replayReviewerReply(evalCase: EvalCase): Promise<string | undefined> {
  const configured = evalCase.replay?.fixtures?.reviewerReply;
  if (!configured) return undefined;
  return loadReviewerReplyFixture(configured);
}
