const PLAN_HEADING = "## Plan";

/** Append or replace the entire `## Plan` section body. The plan body itself
 *  contains `## ` subheaders (Reproduction, Root Cause, ...), so the merge
 *  consumes everything from `## Plan` to end-of-description; pre-plan content
 *  is preserved. */
export function mergeInvestigationPlanIntoDescription(
  description: string | undefined,
  planText: string | undefined
): string | undefined {
  if (!planText?.trim()) return description;
  const trimmedPlan = planText.trim();
  if (!description?.trim()) return `${PLAN_HEADING}\n\n${trimmedPlan}`;

  const planIndex = description.search(/^## Plan\b/m);
  if (planIndex === -1) {
    return `${description.trimEnd()}\n\n${PLAN_HEADING}\n\n${trimmedPlan}`;
  }

  const head = description.slice(0, planIndex).trimEnd();
  return head ? `${head}\n\n${PLAN_HEADING}\n\n${trimmedPlan}` : `${PLAN_HEADING}\n\n${trimmedPlan}`;
}
