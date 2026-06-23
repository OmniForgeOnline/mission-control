import { useState } from "preact/hooks";
import { api } from "@ui/data/api.js";
import { onEnterSubmit } from "@ui/shell/dom.js";
import { requestRefresh } from "@ui/data/refresh.js";
import { getActiveStepIds, taskIsRunning } from "@ui/app/task-status.js";
import { resolvedStepAgent } from "@ui/app/state.js";
import { confirm } from "@ui/overlays/confirm.js";
import { toast, errorToast } from "@ui/overlays/toast.js";
import { TaskMessagesThread } from "../../thread.js";
import { messagesForStep } from "../step-messages.js";
import { AttachmentInput } from "@ui/shared/components/attachments.js";
import type { HarnessAttachment, HarnessTask } from "@ui/app/types.js";

interface StepChatSubmission {
  requestBody: {
    author: "operator";
    body: string;
    stepId: string;
    noteOnly?: true;
  };
  runAfterPost: boolean;
}

function stepLabel(stepId: string): string {
  return stepId.replace(/_/g, " ");
}

export function stepChatSubmission(
  task: HarnessTask,
  stepId: string,
  body: string
): StepChatSubmission {
  const isActive = getActiveStepIds(task).includes(stepId);
  return {
    runAfterPost: isActive,
    requestBody: {
      author: "operator",
      body,
      stepId,
      ...(isActive ? {} : { noteOnly: true })
    }
  };
}

export function StepChat({
  task,
  stepId,
  canRevert
}: {
  task: HarnessTask;
  stepId: string;
  canRevert: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<HarnessAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const messages = messagesForStep(task.messages ?? [], stepId);
  const isRunning = taskIsRunning(task);
  const submission = stepChatSubmission(task, stepId, draft.trim());
  const isActive = submission.runAfterPost;

  async function postMessage(): Promise<void> {
    const text = draft.trim();
    if (!text || uploading) return;
    const requestBody = {
      ...stepChatSubmission(task, stepId, text).requestBody,
      ...(attachments.length ? { attachmentIds: attachments.map((attachment) => attachment.id) } : {})
    };
    try {
      await api(`/api/tasks/${task.id}/messages`, {
        method: "POST",
        body: JSON.stringify(requestBody)
      });
      // Drop the draft and attachments only once the message is posted;
      // clearing earlier orphans uploaded blobs on a transient failure.
      setDraft("");
      setAttachments([]);
      requestRefresh();
    } catch (err) {
      errorToast((err as Error).message);
    }
  }

  async function postRevert(): Promise<void> {
    const text = draft.trim();
    if (!text || isRunning || uploading) return;
    const ok = await confirm({
      title: `Revert to ${stepLabel(stepId)} and resume?`,
      message: "Downstream progress and artifacts are discarded, and this message restarts the step.",
      confirmLabel: "Revert & resume",
      tone: "danger"
    });
    if (!ok) return;
    setDraft("");
    try {
      await api(`/api/tasks/${task.id}/revert-step`, {
        method: "POST",
        body: JSON.stringify({
          stepId,
          message: text,
          run: true,
          ...(attachments.length ? { attachmentIds: attachments.map((attachment) => attachment.id) } : {})
        })
      });
      // Drop attachments only once the revert succeeds, matching postMessage:
      // clearing earlier orphans uploaded blobs on a transient failure.
      setAttachments([]);
      toast(`Reverted to ${stepLabel(stepId)}`, { tone: "success" });
      requestRefresh();
    } catch (err) {
      errorToast((err as Error).message);
    }
  }

  // Plain Enter submits; for a revert-capable completed step the primary action
  // is revert-and-resume, otherwise it sends the scoped message or note.
  const enterSubmit = onEnterSubmit(() => {
    void (canRevert && !isActive ? postRevert() : postMessage());
  });

  const hint = isActive
    ? " · ↵ send to agent · ⇧↵ newline"
    : canRevert
      ? " · ↵ revert & resume · ⇧↵ newline"
      : " · ↵ note only · ⇧↵ newline";

  return (
    <div class="wf-step-discuss">
      <div class="wf-sec-title">Step conversation</div>

      <div class="wf-step-chat">
        <TaskMessagesThread
          task={task}
          messages={messages}
          emptyMessage="No conversation for this step yet."
          showRunning={false}
        />
        {isRunning && isActive ? (
          <div class="wf-step-running">
            <span class="dot" aria-hidden="true" />
            {`${resolvedStepAgent(task, stepId) ?? "agent"} is running this turn${
              task.currentActivity ? ` — ${task.currentActivity}` : ""
            }…`}
          </div>
        ) : null}
      </div>

      <form
        class="wf-step-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void postMessage();
        }}
      >
        <textarea
          rows={3}
          placeholder={`Message about ${stepLabel(stepId)}…`}
          value={draft}
          onInput={(event) => {
            setDraft((event.currentTarget as HTMLTextAreaElement).value);
          }}
          onKeyDown={enterSubmit}
        />
        <AttachmentInput
          value={attachments}
          onChange={setAttachments}
          source="workflow"
          onUploadingChange={setUploading}
        />
        <div class="wf-step-composer-foot">
          <span class="hint">
            Scoped to <b>{stepLabel(stepId)}</b>
            {hint}
          </span>
          <div class="wf-step-composer-actions">
            {isActive ? (
              <button class="btn btn-sm btn-primary" type="submit" disabled={uploading}>
                Send to agent
              </button>
            ) : canRevert ? (
              <>
                <button
                  class="btn btn-sm btn-danger"
                  type="button"
                  disabled={isRunning || uploading}
                  onClick={() => void postRevert()}
                >
                  Revert & resume
                </button>
                <button
                  class="btn btn-sm"
                  type="button"
                  disabled={uploading}
                  onClick={() => void postMessage()}
                >
                  Add note
                </button>
              </>
            ) : (
              <button
                class="btn btn-sm btn-primary"
                type="button"
                disabled={uploading}
                onClick={() => void postMessage()}
              >
                Send
              </button>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}
