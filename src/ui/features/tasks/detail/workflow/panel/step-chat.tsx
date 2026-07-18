import { useState } from "preact/hooks";
import { api } from "@ui/data/api.js";
import { onEnterSubmit } from "@ui/shell/dom.js";
import { requestRefresh } from "@ui/data/refresh.js";
import { getActiveStepIds, taskIsRunning } from "@ui/app/task-status.js";
import { resolvedStepAgent } from "@ui/app/state.js";
import { errorToast } from "@ui/overlays/toast.js";
import { TaskMessagesThread } from "../../thread.js";
import { messagesForStep } from "../step-messages.js";
import { AttachmentInput } from "@ui/shared/components/attachments.js";
import type { HarnessAttachment, HarnessTask } from "@ui/app/types.js";

interface StepChatSubmission {
  requestBody: {
    author: "operator";
    body: string;
    stepId: string;
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
      stepId
    }
  };
}

export function StepChat({
  task,
  stepId
}: {
  task: HarnessTask;
  stepId: string;
}) {
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<HarnessAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const messages = messagesForStep(task.messages ?? [], stepId);
  const isRunning = taskIsRunning(task);
  const isActive = getActiveStepIds(task).includes(stepId);

  async function postMessage(): Promise<void> {
    const text = draft.trim();
    if (!text || uploading || !isActive) return;
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

  const enterSubmit = onEnterSubmit(() => {
    void postMessage();
  });

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

      {isActive ? (
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
              {" · ↵ send to agent · ⇧↵ newline"}
            </span>
            <div class="wf-step-composer-actions">
              <button class="btn btn-sm btn-primary" type="submit" disabled={uploading}>
                Send to agent
              </button>
            </div>
          </div>
        </form>
      ) : null}
    </div>
  );
}
