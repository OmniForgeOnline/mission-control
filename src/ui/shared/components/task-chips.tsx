import { icon } from "@ui/shell/icons.js";
import type { HarnessTask } from "@ui/app/types.js";

function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return <span dangerouslySetInnerHTML={{ __html: icon(name, size) }} />;
}

export function StatusBadge({ status, className = "badge" }: { status: string; className?: string }) {
  return (
    <span class={className} data-tone={status}>
      <span class="dot" />
      {status.replace(/_/g, " ")}
    </span>
  );
}

export function BranchChip({ branch }: { branch: string }) {
  return (
    <span class="chip chip-mono" data-copy={branch} title="Click to copy">
      <Icon name="git-branch" size={12} />
      {branch}
    </span>
  );
}

export function MergeRequestChip({
  mergeRequest
}: {
  mergeRequest: NonNullable<HarnessTask["mergeRequest"]>;
}) {
  const label = mergeRequest.provider === "github" ? "PR" : "MR";
  return (
    <a
      class="chip chip-mono"
      href={mergeRequest.url}
      target="_blank"
      rel="noopener noreferrer"
      title="Open merge request"
    >
      <Icon name="external-link" size={12} />
      {label} #{mergeRequest.number}
    </a>
  );
}