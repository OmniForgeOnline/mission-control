import { useState } from "preact/hooks";

import {
  appendAttachments,
  attachmentUrl,
  collectUploads,
  formatAttachmentSize,
  removeAttachment,
  uploadAttachment
} from "@ui/data/attachments.js";
import { errorToast } from "@ui/overlays/toast.js";
import { icon } from "@ui/shell/icons.js";
import type { HarnessAttachment } from "@ui/app/types.js";

/** Read-only list of attachments with download links. */
export function AttachmentChips({ attachments }: { attachments: HarnessAttachment[] }) {
  if (!attachments?.length) return null;
  return (
    <ul class="attachment-chips">
      {attachments.map((attachment) => (
        <li class="attachment-chip" key={attachment.id} title={attachment.sourceUrl ?? attachment.filename}>
          <a
            class="attachment-chip-link"
            href={attachmentUrl(attachment.id)}
            download={attachment.filename}
          >
            <span class="attachment-chip-name">{attachment.filename}</span>
            <span class="attachment-chip-size muted">{formatAttachmentSize(attachment.size)}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

/**
 * Controlled attachment picker. Uploads each selected file immediately, appends
 * the resulting metadata via `onChange`, and lets the operator remove a pending
 * file before submitting. The parent owns the list and reads ids at submit time.
 *
 * `onChange` takes a transition over the parent's latest list, not a snapshot.
 * Appends and removals are applied as functional updates so they compose
 * correctly with edits that land while an upload is in flight: a removal the
 * operator makes mid-upload is never resurrected when that upload resolves.
 *
 * Files upload independently: a failure for one file never drops its already
 * landed siblings from the list. `onChange` fires once after the whole selection
 * has been attempted, carrying every success. `onUploadingChange` lifts the
 * in-flight flag so the parent can keep submit disabled until the picked files
 * are actually on the list, otherwise a fast submit would drop just-chosen
 * attachments.
 */
export function AttachmentInput({
  value,
  onChange,
  source,
  disabled,
  onUploadingChange
}: {
  value: HarnessAttachment[];
  onChange: (update: (prev: HarnessAttachment[]) => HarnessAttachment[]) => void;
  source: "intake" | "workflow";
  disabled?: boolean;
  onUploadingChange?: (uploading: boolean) => void;
}) {
  const [uploading, setUploading] = useState(false);

  function syncUploading(next: boolean): void {
    setUploading(next);
    onUploadingChange?.(next);
  }

  async function handleFiles(fileList: FileList | null): Promise<void> {
    if (!fileList || !fileList.length || uploading) return;
    syncUploading(true);
    try {
      const { uploaded, failed } = await collectUploads(Array.from(fileList), (file) =>
        uploadAttachment(file, source)
      );
      if (uploaded.length) {
        onChange((prev) => appendAttachments(prev, uploaded));
      }
      if (failed.length) {
        const noun = failed.length === 1 ? "file" : "files";
        errorToast(`Could not attach ${failed.length} ${noun}: ${failed.join(", ")}`);
      }
    } finally {
      syncUploading(false);
    }
  }

  return (
    <div class="attachment-input">
      <label
        class={`attachment-input-pick${uploading ? " is-uploading" : ""}`}
        aria-label={uploading ? "Uploading files" : "Attach files"}
        title={uploading ? "Uploading files" : "Attach files"}
      >
        <span dangerouslySetInnerHTML={{ __html: icon("paperclip", 17) }} />
        <input
          type="file"
          multiple
          disabled={disabled || uploading}
          onChange={(event) => {
            void handleFiles((event.currentTarget as HTMLInputElement).files);
            // Reset so selecting the same file again re-fires onChange.
            (event.currentTarget as HTMLInputElement).value = "";
          }}
        />
      </label>
      {value.length ? (
        <ul class="attachment-input-list">
          {value.map((attachment) => (
            <li class="attachment-input-item" key={attachment.id}>
              <span class="attachment-input-name">{attachment.filename}</span>
              <span class="muted">{formatAttachmentSize(attachment.size)}</span>
              <button
                type="button"
                class="btn btn-sm attachment-input-remove"
                disabled={disabled}
                onClick={() => onChange((prev) => removeAttachment(prev, attachment.id))}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
