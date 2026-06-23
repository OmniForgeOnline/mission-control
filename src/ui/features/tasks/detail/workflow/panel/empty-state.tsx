import { icon } from "@ui/shell/icons.js";

/** Centered empty/placeholder state shared by the workflow side-panel tabs. */
export function WorkflowEmptyState({
  icon: iconName,
  title,
  body
}: {
  icon: string;
  title: string;
  body: string;
}) {
  return (
    <div class="wf-empty-state">
      <span class="wf-empty-icon" dangerouslySetInnerHTML={{ __html: icon(iconName, 18) }} />
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
  );
}
