import { gitChangedFiles } from "../infra/git.ts";
import type { RemoteRepoIdentity } from "./types.ts";

/** Image extensions treated as candidate screenshot artifacts. */
const SCREENSHOT_IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif"] as const;

/**
 * Directory segment that marks an image as an intentional review screenshot.
 * Keeping this explicit avoids grabbing unrelated project assets (icons, hero images).
 */
export const SCREENSHOTS_DIR_SEGMENT = "screenshots";

/**
 * Workflows whose completed changes are UI-involved. Embedding is gated on this set so
 * backend/infra/docs workflows are never affected. Extend here to opt more workflows in.
 */
export const UI_SCREENSHOT_WORKFLOW_IDS = new Set<string>(["frontend-ui-change"]);

/** Maximum screenshots embedded in a single merge-request description. */
const MAX_SCREENSHOTS = 4;

export const VISUAL_REVIEW_HEADING = "## Visual Review";

export function isUiInvolvedWorkflow(workflowId: string | undefined | null): boolean {
  return Boolean(workflowId) && UI_SCREENSHOT_WORKFLOW_IDS.has(workflowId as string);
}

function hasImageExtension(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return SCREENSHOT_IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** A committed file counts as a screenshot artifact when it is an image under a `screenshots/` path. */
export function isScreenshotArtifact(filePath: string): boolean {
  return hasImageExtension(filePath) && filePath.split("/").includes(SCREENSHOTS_DIR_SEGMENT);
}

/**
 * Committed screenshot artifacts introduced on the branch (relative to the base branch).
 * Uncommitted files are ignored: the artifact must travel with the pushed branch to be reachable.
 */
export async function detectCommittedScreenshots(cwd: string, baseBranch: string): Promise<string[]> {
  const changed = await gitChangedFiles(cwd, baseBranch);
  const screenshots = changed.filter(isScreenshotArtifact);
  return [...new Set(screenshots)].sort().slice(0, MAX_SCREENSHOTS);
}

function encodePathSegments(value: string): string {
  return value
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

/**
 * Forge raw URL for a file committed on the branch. Both GitHub and GitLab render these inline in
 * merge-request descriptions for reviewers with repo access, so a single mechanism covers both forges
 * without forge-specific upload APIs.
 */
export function buildScreenshotRawUrl(repo: RemoteRepoIdentity, branch: string, filePath: string): string {
  const ref = encodePathSegments(branch);
  const file = encodePathSegments(filePath);
  if (repo.host === "github.com") {
    return `https://github.com/${repo.slug}/raw/${ref}/${file}`;
  }
  return `https://gitlab.com/${repo.slug}/-/raw/${ref}/${file}`;
}

export interface ScreenshotEmbed {
  alt: string;
  url: string;
}

export function buildScreenshotEmbeds(
  repo: RemoteRepoIdentity,
  branch: string,
  screenshots: string[]
): ScreenshotEmbed[] {
  return screenshots.map((filePath) => ({
    alt: `UI change: ${filePath}`,
    url: buildScreenshotRawUrl(repo, branch, filePath)
  }));
}

/** Markdown "Visual Review" section embedding each screenshot. Empty when there is nothing to embed. */
export function buildVisualReviewSection(
  repo: RemoteRepoIdentity,
  branch: string,
  screenshots: string[]
): string {
  if (!screenshots.length) return "";
  const images = buildScreenshotEmbeds(repo, branch, screenshots)
    .map((embed) => `![${embed.alt}](${embed.url})`)
    .join("\n\n");
  return `${VISUAL_REVIEW_HEADING}\n\n${images}`;
}

/** Append the visual review section to a description; no-op for an empty section. */
export function appendVisualReviewSection(description: string, section: string): string {
  if (!section.trim()) return description;
  return `${description.trimEnd()}\n\n${section}`;
}
