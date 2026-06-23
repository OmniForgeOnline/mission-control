import type { ComponentChildren } from "preact";

export interface ViewShellProps {
  id?: string;
  title: string;
  subtitle?: string;
  actions?: ComponentChildren;
  children?: ComponentChildren;
  /** Legacy HTML body for vanilla string consumers. */
  body?: string;
}

export function ViewShell({ id, title, subtitle, actions, children, body }: ViewShellProps) {
  return (
    <div class="view" id={id}>
      <div class="view-header">
        <div>
          <h1 class="view-title">{title}</h1>
          {subtitle ? <p class="view-subtitle">{subtitle}</p> : null}
        </div>
        {actions ? <div class="view-actions">{actions}</div> : null}
      </div>
      {children ?? (body ? <div dangerouslySetInnerHTML={{ __html: body }} /> : null)}
    </div>
  );
}