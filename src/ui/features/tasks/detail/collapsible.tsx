import { icon } from "@ui/shell/icons.js";

const COLLAPSE_CHAR_THRESHOLD = 480;
const COLLAPSE_LINE_THRESHOLD = 8;
const collapseOverrides = new Map<string, boolean>();

function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return <span dangerouslySetInnerHTML={{ __html: icon(name, size) }} />;
}

export function collapseKey(taskId: string, blockId: string): string {
  return `${taskId}:${blockId}`;
}

export function isCollapsibleText(text: string): boolean {
  return text.length > COLLAPSE_CHAR_THRESHOLD || text.split("\n").length > COLLAPSE_LINE_THRESHOLD;
}

export function isBlockExpanded(taskId: string, blockId: string, defaultExpanded: boolean): boolean {
  const key = collapseKey(taskId, blockId);
  return collapseOverrides.has(key) ? collapseOverrides.get(key)! : defaultExpanded;
}

function collapseSummary(text: string): string {
  const plain = text.replace(/\s+/g, " ").trim();
  if (plain.length <= 96) return plain;
  return `${plain.slice(0, 96)}…`;
}

export function toggleCollapsibleBlock(toggle: HTMLElement): void {
  const key = toggle.dataset["collapseKey"];
  if (!key) return;

  const defaultExpanded = toggle.dataset["collapseDefault"] === "true";
  const splitAt = key.indexOf(":");
  if (splitAt === -1) return;
  const taskId = key.slice(0, splitAt);
  const blockId = key.slice(splitAt + 1);
  if (!taskId || !blockId) return;

  const expanded = isBlockExpanded(taskId, blockId, defaultExpanded);
  collapseOverrides.set(key, !expanded);

  const nested = toggle.closest<HTMLElement>(".collapsible");
  const messageHost = toggle.closest<HTMLElement>(".message.is-collapsible");
  const host = nested ?? messageHost;
  const panel = nested
    ? nested.querySelector<HTMLElement>(":scope > .collapsible-panel")
    : messageHost?.querySelector<HTMLElement>(":scope > .collapsible-panel");
  const chevron = toggle.querySelector<HTMLElement>(".collapsible-chevron");
  const nextExpanded = !expanded;

  if (panel) panel.hidden = !nextExpanded;
  toggle.setAttribute("aria-expanded", String(nextExpanded));
  chevron?.classList.toggle("is-open", nextExpanded);
  host?.classList.toggle("is-expanded", nextExpanded);
}

export function CollapsibleBlock({
  taskId,
  blockId,
  rawText,
  html,
  defaultExpanded,
  panelClass,
  triggerLabel,
  editable,
  editField,
  forceCollapsible = false
}: {
  taskId: string;
  blockId: string;
  rawText: string;
  html: string;
  defaultExpanded: boolean;
  panelClass: string;
  triggerLabel?: string;
  editable?: boolean;
  editField?: "title" | "description";
  forceCollapsible?: boolean;
}) {
  if (!forceCollapsible && !isCollapsibleText(rawText)) {
    return (
      <div
        class={`${panelClass} message-body${editable && editField ? " editable" : ""}`}
        data-edit={editable && editField ? editField : undefined}
        title={editable && editField ? "Click to edit" : undefined}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  const key = collapseKey(taskId, blockId);
  const expanded = isBlockExpanded(taskId, blockId, defaultExpanded);

  return (
    <div class={`collapsible${expanded ? " is-expanded" : ""}`} data-collapse-key={key}>
      <button
        type="button"
        class="collapsible-trigger"
        aria-expanded={expanded}
        data-collapse-toggle
        data-collapse-key={key}
        data-collapse-default={defaultExpanded}
        onClick={(event) => {
          toggleCollapsibleBlock(event.currentTarget as HTMLElement);
        }}
      >
        <span class={`collapsible-chevron${expanded ? " is-open" : ""}`}>
          <Icon name="chevron-right" size={14} />
        </span>
        {triggerLabel ? <span class="collapsible-label">{triggerLabel}</span> : null}
        <span class="collapsible-summary">{collapseSummary(rawText)}</span>
      </button>
      <div
        class={`collapsible-panel ${panelClass} message-body${editable && editField ? " editable" : ""}`}
        hidden={!expanded}
        data-edit={editable && editField ? editField : undefined}
        title={editable && editField ? "Click to edit" : undefined}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}