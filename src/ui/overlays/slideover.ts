import { api } from "@ui/data/api.js";
import { $, escapeHtml } from "@ui/shell/dom.js";
import { icon } from "@ui/shell/icons.js";
import { toast } from "@ui/overlays/toast.js";
import { bindDialogDismiss } from "./dialog.ts";
import { renderMarkdown } from "@ui/shared/lib/markdown.js";
import type { MemoryPage } from "@ui/app/types.js";

const dlg = (): HTMLDialogElement => $("#slideDialog") as HTMLDialogElement;

function panel(): HTMLElement {
  const d = dlg();
  let slot = d.querySelector<HTMLElement>(".slideover-panel");
  if (!slot) {
    d.innerHTML = `<div class="slideover-panel"></div>`;
    slot = d.querySelector<HTMLElement>(".slideover-panel")!;
    bindDialogDismiss(d);
  }
  return slot;
}

function open(html: string): void {
  const d = dlg();
  panel().innerHTML = html;
  if (!d.open) d.showModal();
}

function close(): void {
  dlg().close();
  panel().innerHTML = "";
}

export function setWorkflowChoices(workflows: Array<{ id: string; name: string }>): void {
  (window as unknown as { __harnessWorkflows?: Array<{ id: string; name: string }> }).__harnessWorkflows = workflows;
}

export function openCaptureMemory(options?: { projectId: string }): void {
  const projectId = options?.projectId ?? "";
  open(`
    <form id="memForm" class="slideover-form">
      <div class="head">
        <h2>Capture memory</h2>
        <button class="btn btn-ghost btn-icon" type="button" id="closeSlide">${icon("x", 14)}</button>
      </div>
      <div class="body">
        <div class="form-grid">
          <label class="field">
            <span class="field-label">Slug</span>
            <input class="input" name="slug" required placeholder="preferences/python-testing" />
          </label>
          <label class="field">
            <span class="field-label">Type</span>
            <select class="select" name="type">
              <option value="note">Note</option>
              <option value="preference">Preference</option>
              <option value="decision">Decision</option>
              <option value="project">Project</option>
              <option value="entity">Entity</option>
            </select>
          </label>
          <label class="field wide">
            <span class="field-label">Title</span>
            <input class="input" name="title" required placeholder="Python testing preferences" />
          </label>
          <label class="field wide">
            <span class="field-label">Tags</span>
            <input class="input" name="tags" placeholder="testing, python" />
          </label>
          <label class="field wide">
            <span class="field-label">Content</span>
            <textarea class="textarea" name="content" required rows="8"></textarea>
          </label>
        </div>
      </div>
      <div class="foot">
        <button class="btn btn-ghost" type="button" id="cancelSlide">Cancel</button>
        <button class="btn btn-primary" type="submit" id="submitMem">${icon("brain", 14)}<span>Capture</span></button>
      </div>
    </form>
  `);
  const form = $("#memForm") as HTMLFormElement;
  const submitBtn = $("#submitMem") as HTMLButtonElement | null;
  $("#closeSlide")?.addEventListener("click", close);
  $("#cancelSlide")?.addEventListener("click", close);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    if (submitBtn) submitBtn.disabled = true;
    try {
      const fd = new FormData(form);
      const tags = (fd.get("tags") || "")
        .toString()
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      await api("/api/memory/pages", {
        method: "POST",
        body: JSON.stringify({
          projectId,
          slug: fd.get("slug"),
          type: fd.get("type"),
          title: fd.get("title"),
          tags,
          content: fd.get("content")
        })
      });
      toast("Memory captured.", { tone: "success" });
      close();
      document.dispatchEvent(new CustomEvent("harness:refresh"));
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });
}

export function openMemoryPreview(page: MemoryPage): void {
  open(`
    <div class="head">
      <h2>${escapeHtml(page.title)}</h2>
      <button class="btn btn-ghost btn-icon" id="closeSlide">${icon("x", 14)}</button>
    </div>
    <div class="body">
      <div class="meta-line" style="margin-bottom:var(--s-3);color:var(--ink-faint)">
        <span class="chip mono">${escapeHtml(page.slug ?? "")}</span>
        ${page.type ? `<span>${escapeHtml(page.type)}</span>` : ""}
        ${(page.tags ?? []).map((t) => `<span class="chip">${escapeHtml(t)}</span>`).join(" ")}
      </div>
      <div class="message-body" style="white-space:pre-wrap;font-size:var(--t-md);line-height:1.6">${escapeHtml(page.content ?? "")}</div>
    </div>
  `);
  $("#closeSlide")?.addEventListener("click", close);
}

export async function openArtifactViewer(url: string, title?: string): Promise<void> {
  const label = title ?? url.split("/").pop() ?? "Artifact";
  open(`
    <div class="head">
      <h2>${escapeHtml(label)}</h2>
      <button class="btn btn-ghost btn-icon" id="closeSlide">${icon("x", 14)}</button>
    </div>
    <div class="body artifact-body">
      <div class="artifact-loading muted">Loading…</div>
    </div>
  `);
  $("#closeSlide")?.addEventListener("click", close);

  const body = $(".artifact-body");
  if (!body) return;

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to load artifact (${res.status})`);
    const text = await res.text();
    const isMarkdown = label.endsWith(".md") || text.trimStart().startsWith("#");
    body.innerHTML = isMarkdown
      ? `<div class="message-body">${renderMarkdown(text)}</div>`
      : `<pre class="artifact-raw mono">${escapeHtml(text)}</pre>`;
  } catch (err) {
    body.innerHTML = `<div class="artifact-error">${escapeHtml((err as Error).message)}</div>`;
  }
}