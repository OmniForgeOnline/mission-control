import { escapeHtml } from "@ui/shell/dom.js";
import { icon } from "@ui/shell/icons.js";
import { close } from "./close.ts";
import { coalesceStreamEvents, toRows } from "./parse.ts";
import { setStickFor, type Row, type TailInstance } from "./state.ts";

function statusBanner(inst: TailInstance): string {
  if (inst.status === "complete") {
    return `<div class="tail-status tail-status-complete">Run complete — tail stopped.</div>`;
  }
  if (inst.status === "error") {
    return `<div class="tail-status tail-status-error">${escapeHtml(inst.errorMessage ?? "Tail stream failed")}</div>`;
  }
  return "";
}

function rowHtml(row: Row, inst: TailInstance): string {
  const expandable = row.detail != null;
  const isOpen = inst.expanded.has(row.id);
  const head = `
    <div class="tail-rowhead${expandable ? " expandable" : ""}${isOpen ? " is-open" : ""}"${expandable ? ` data-row="${row.id}"` : ""}>
      <span class="tail-ico">${icon(row.ico, 13)}</span>
      <span class="tail-kind">${escapeHtml(row.kind)}</span>
      <span class="tail-title">${escapeHtml(row.title)}</span>
      ${expandable ? `<span class="tail-chevron">${icon("chevron-right", 13)}</span>` : ""}
    </div>`;
  const body = row.body ? `<div class="tail-text">${escapeHtml(row.body)}</div>` : "";
  const detail = expandable
    ? `<pre class="tail-detail" data-detail="${row.id}"${isOpen ? "" : " hidden"}>${escapeHtml(row.detail!)}</pre>`
    : "";
  return `<div class="tail-row tone-${row.tone}">${head}${body}${detail}</div>`;
}

function bindStreamInteractions(inst: TailInstance, stream: HTMLElement): void {
  stream.querySelectorAll<HTMLElement>("[data-row]").forEach((el) => {
    if (el.dataset["bound"]) return;
    el.dataset["bound"] = "true";
    el.addEventListener("click", () => {
      const id = el.dataset["row"]!;
      const open = inst.expanded.has(id);
      if (open) inst.expanded.delete(id);
      else inst.expanded.add(id);
      const detail = stream.querySelector<HTMLElement>(`.tail-detail[data-detail="${id}"]`);
      if (detail) detail.hidden = open;
      el.classList.toggle("is-open", !open);
    });
  });

  if (stream.dataset["scrollBound"]) return;
  stream.dataset["scrollBound"] = "true";
  stream.addEventListener("scroll", () => {
    const nearBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 24;
    if (inst.stick !== nearBottom) {
      setStickFor(inst.runId, nearBottom);
      const box = inst.host?.querySelector<HTMLInputElement>("[data-tail-stick]");
      if (box) box.checked = inst.stick;
    }
  });
}

function buildPanelHtml(inst: TailInstance, rows: Row[]): string {
  return `
    <div class="tail-panel" data-tail-panel="${inst.runId}">
      <div class="tail-head">
        <span class="tail-head-title">${icon("terminal", 13)}<strong>${escapeHtml(inst.title)}</strong></span>
        <div class="tail-head-actions">
          <label class="tail-stick"><input type="checkbox" data-tail-stick${inst.stick ? " checked" : ""}/> stick to bottom</label>
          <button class="btn btn-ghost btn-icon" data-tail-close="${inst.runId}" title="Close">${icon("x", 13)}</button>
        </div>
      </div>
      ${statusBanner(inst)}
      <div class="tail-stream" data-tail-stream="${inst.runId}">
        ${rows.length ? rows.map((row) => rowHtml(row, inst)).join("") : `<div class="tail-empty">Waiting for output…</div>`}
      </div>
    </div>
  `;
}

function bindPanelChrome(inst: TailInstance): void {
  if (!inst.host) return;
  inst.host.querySelector<HTMLButtonElement>(`[data-tail-close="${inst.runId}"]`)?.addEventListener("click", () => {
    close(inst.runId);
  });
  inst.host.querySelector<HTMLInputElement>("[data-tail-stick]")?.addEventListener("change", (event) => {
    const checked = (event.target as HTMLInputElement).checked;
    setStickFor(inst.runId, checked);
    const stream = inst.host?.querySelector<HTMLElement>(`[data-tail-stream="${inst.runId}"]`);
    if (checked && stream) stream.scrollTop = stream.scrollHeight;
  });
}

export function renderInstance(inst: TailInstance): void {
  if (!inst.host) return;

  const rows = coalesceStreamEvents(inst.events).flatMap(toRows);
  const panel = inst.host.querySelector(`[data-tail-panel="${inst.runId}"]`);
  const stream = inst.host.querySelector<HTMLElement>(`[data-tail-stream="${inst.runId}"]`);

  if (!panel || !stream) {
    inst.host.innerHTML = buildPanelHtml(inst, rows);
    inst.renderedRows = rows.length;
    bindPanelChrome(inst);
    const freshStream = inst.host.querySelector<HTMLElement>(`[data-tail-stream="${inst.runId}"]`);
    if (freshStream) {
      bindStreamInteractions(inst, freshStream);
      if (inst.stick) freshStream.scrollTop = freshStream.scrollHeight;
    }
    return;
  }

  const banner = inst.host.querySelector(".tail-status");
  const bannerHtml = statusBanner(inst);
  if (bannerHtml && !banner) {
    stream.insertAdjacentHTML("beforebegin", bannerHtml);
  } else if (!bannerHtml && banner) {
    banner.remove();
  } else if (banner) {
    banner.outerHTML = bannerHtml;
  }

  const empty = stream.querySelector(".tail-empty");
  if (rows.length && empty) empty.remove();

  if (rows.length > inst.renderedRows) {
    const slice = rows.slice(inst.renderedRows);
    stream.insertAdjacentHTML("beforeend", slice.map((row) => rowHtml(row, inst)).join(""));
    inst.renderedRows = rows.length;
    bindStreamInteractions(inst, stream);
  }

  if (inst.stick) stream.scrollTop = stream.scrollHeight;
}