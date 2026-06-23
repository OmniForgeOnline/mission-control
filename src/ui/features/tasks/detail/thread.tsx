import { type ComponentChild } from "preact";
import { icon } from "@ui/shell/icons.js";
import { renderMarkdown } from "@ui/shared/lib/markdown.js";
import { resolvedStepAgent } from "@ui/app/state.js";
import { splitPlanningMessage } from "../../../../core/workflows/planning-message.ts";
import { taskIsRunning } from "@ui/app/task-status.js";
import type { HarnessMessage, HarnessTask } from "@ui/app/types.js";
import {
  CollapsibleBlock,
  collapseKey,
  isBlockExpanded,
  isCollapsibleText,
  toggleCollapsibleBlock
} from "./collapsible.js";
import { AttachmentChips } from "@ui/shared/components/attachments.js";

function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return <span dangerouslySetInnerHTML={{ __html: icon(name, size) }} />;
}

function collapseSummary(text: string): string {
  const plain = text.replace(/\s+/g, " ").trim();
  if (plain.length <= 96) return plain;
  return `${plain.slice(0, 96)}…`;
}

function authorIcon(author: string): ComponentChild {
  if (author === "agent") return <Icon name="bot" size={12} />;
  if (author === "operator") return <Icon name="user" size={12} />;
  return <Icon name="workflow" size={12} />;
}

function PlanningMessageBody({
  task,
  message,
  index,
  total
}: {
  task: HarnessTask;
  message: HarnessMessage;
  index: number;
  total: number;
}) {
  const parts = splitPlanningMessage(message.body);
  if (!parts) {
    return <div class="message-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(message.body) }} />;
  }

  const defaultExpanded = index === total - 1;
  const blocks: ComponentChild[] = [];

  if (parts.preamble) {
    blocks.push(
      <CollapsibleBlock
        taskId={task.id}
        blockId={`${message.id}:discussion`}
        rawText={parts.preamble}
        html={renderMarkdown(parts.preamble, "part")}
        defaultExpanded={false}
        panelClass="planning-section"
        triggerLabel="Discussion"
        forceCollapsible
      />
    );
  }

  blocks.push(
    <CollapsibleBlock
      taskId={task.id}
      blockId={`${message.id}:plan`}
      rawText={parts.plan}
      html={renderMarkdown(parts.plan, "part")}
      defaultExpanded={defaultExpanded}
      panelClass="planning-section planning-plan"
      triggerLabel="Proposed plan"
      forceCollapsible
    />
  );

  return <div class="planning-sections">{blocks}</div>;
}

function MessageArticle({
  task,
  message,
  index,
  total
}: {
  task: HarnessTask;
  message: HarnessMessage;
  index: number;
  total: number;
}) {
  const time = new Date(message.createdAt).toLocaleString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    day: "numeric"
  });
  const planningParts = splitPlanningMessage(message.body);
  const collapsible = !planningParts && isCollapsibleText(message.body);
  const defaultExpanded = index === total - 1;
  const key = collapseKey(task.id, message.id);
  const expanded = isBlockExpanded(task.id, message.id, defaultExpanded);
  const summaryText = planningParts
    ? planningParts.plan || planningParts.preamble || message.body
    : message.body;

  const bodyContent = planningParts ? (
    <PlanningMessageBody task={task} message={message} index={index} total={total} />
  ) : (
    <div class="message-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(message.body) }} />
  );

  const header = collapsible ? (
    <button
      type="button"
      class="message-header message-collapse-trigger"
      aria-expanded={expanded}
      data-collapse-toggle
      data-collapse-key={key}
      data-collapse-default={defaultExpanded}
      onClick={(event) => {
        toggleCollapsibleBlock(event.currentTarget as HTMLElement);
      }}
    >
      <span class="message-header-main">
        <span class={`collapsible-chevron${expanded ? " is-open" : ""}`}>
          <Icon name="chevron-right" size={14} />
        </span>
        <span class={`message-author ${message.author}`}>
          {authorIcon(message.author)}
          {message.author}
        </span>
        <span class="collapsible-summary">{collapseSummary(summaryText)}</span>
      </span>
      <span class="message-time">{time}</span>
    </button>
  ) : (
    <div class="message-header">
      <span class="message-header-main">
        <span class={`message-author ${message.author}`}>
          {authorIcon(message.author)}
          {message.author}
        </span>
        {planningParts?.turnLabel ? (
          <span class="planning-turn-label">{planningParts.turnLabel}</span>
        ) : null}
        {planningParts ? (
          <span class="collapsible-summary">{collapseSummary(summaryText)}</span>
        ) : null}
      </span>
      <span class="message-time">{time}</span>
    </div>
  );

  const body = collapsible ? (
    <div class="collapsible-panel message-body" hidden={!expanded}>
      {bodyContent}
    </div>
  ) : (
    bodyContent
  );

  return (
    <article
      class={`message author-${message.author}${planningParts ? " has-planning-sections" : ""}${collapsible ? " is-collapsible" : ""}${expanded ? " is-expanded" : ""}`}
      data-message-id={message.id}
      data-collapse-key={collapsible ? key : undefined}
    >
      {header}
      {body}
      {message.attachments?.length ? (
        <div class="message-attachments">
          <AttachmentChips attachments={message.attachments} />
        </div>
      ) : null}
    </article>
  );
}

function RunningIndicator({ task }: { task: HarnessTask }) {
  const activity = task.currentActivity ? ` — ${task.currentActivity}` : "";
  return (
    <article class="message author-agent" data-running-indicator>
      <div class="message-running">
        <span class="dot" />
        {resolvedStepAgent(task) ?? "agent"} is running this turn{activity}…
      </div>
    </article>
  );
}

export function TaskMessagesThread({
  task,
  messages,
  emptyMessage = "No messages yet. Run the task to start a turn.",
  showRunning = taskIsRunning(task)
}: {
  task: HarnessTask;
  messages: HarnessMessage[];
  emptyMessage?: string;
  showRunning?: boolean;
}) {
  const isRunning = taskIsRunning(task);

  if (!messages.length && !showRunning) {
    return <div class="thread-empty">{emptyMessage}</div>;
  }

  return (
    <div class="thread">
      {messages.map((message, index) => (
        <MessageArticle
          key={message.id}
          task={task}
          message={message}
          index={index}
          total={messages.length}
        />
      ))}
      {isRunning && showRunning ? <RunningIndicator task={task} /> : null}
    </div>
  );
}
