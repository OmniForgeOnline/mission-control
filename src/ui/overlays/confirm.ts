import { $, escapeHtml } from "@ui/shell/dom.js";
import { bindDialogDismiss } from "./dialog.ts";

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "danger" | "default";
}

function confirmDialog(): HTMLDialogElement {
  return $("#confirmDialog") as HTMLDialogElement;
}

export function confirm(opts: ConfirmOptions): Promise<boolean> {
  const dlg = confirmDialog();
  if (!dlg) return Promise.resolve(false);

  const confirmLabel = opts.confirmLabel ?? "Confirm";
  const cancelLabel = opts.cancelLabel ?? "Cancel";
  const confirmClass = opts.tone === "danger" ? "btn btn-danger" : "btn btn-primary";

  dlg.innerHTML = `
    <div class="confirm-panel" role="alertdialog" aria-labelledby="confirmTitle" aria-describedby="confirmMessage">
      <h2 id="confirmTitle" class="confirm-title">${escapeHtml(opts.title)}</h2>
      <p id="confirmMessage" class="confirm-message">${escapeHtml(opts.message)}</p>
      <div class="confirm-actions">
        <button class="btn btn-ghost" type="button" id="confirmCancel">${escapeHtml(cancelLabel)}</button>
        <button class="${confirmClass}" type="button" id="confirmOk">${escapeHtml(confirmLabel)}</button>
      </div>
    </div>
  `;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      dlg.close();
      resolve(value);
    };

    const onCancel = (): void => finish(false);
    const onConfirm = (): void => finish(true);

    $("#confirmCancel")?.addEventListener("click", onCancel);
    $("#confirmOk")?.addEventListener("click", onConfirm);
    dlg.addEventListener(
      "cancel",
      (event) => {
        event.preventDefault();
        onCancel();
      },
      { once: true }
    );
    bindDialogDismiss(dlg);
    dlg.showModal();
    ($("#confirmOk") as HTMLButtonElement | null)?.focus();
  });
}