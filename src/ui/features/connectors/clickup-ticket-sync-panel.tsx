import { useEffect, useRef } from "preact/hooks";
import { ui } from "@ui/app/state.js";
import { AutonomyJobRow } from "@ui/features/autonomy/page.js";
import { bindTails } from "@ui/features/runs/tail.js";

const CLICKUP_TICKET_SYNC_JOB_ID = "clickup-ticket-sync";

/** Ticket sync controls for the ClickUp connector detail (harness autonomy job, relocated UI). */
export function ClickUpTicketSyncPanel() {
  const job = (ui.data?.autonomyJobs ?? []).find((entry) => entry.id === CLICKUP_TICKET_SYNC_JOB_ID);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (panelRef.current) bindTails(panelRef.current);
  });

  if (!job) return null;

  return (
    <>
      <div class="catalog-section-label">Ticket sync</div>
      <div class="autonomy-panel" ref={panelRef} data-clickup-ticket-sync>
        <AutonomyJobRow job={job} />
      </div>
    </>
  );
}
