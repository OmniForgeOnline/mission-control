import { REVIEW_PROFILE_IDS, type ReviewProfileId, type WorkflowStep } from "../workflows/types.ts";

export type { ReviewProfileId } from "../workflows/types.ts";
export { REVIEW_PROFILE_IDS };

export const PROFILE_CONSEQUENTIAL: Record<ReviewProfileId, boolean> = {
  code: true,
  frontend: true,
  "technical-doc": false,
  content: false,
  data: true,
  decision: true,
  incident: true,
  support: true
};

export interface ReviewProfileDefinition {
  id: ReviewProfileId;
  label: string;
  standards: string;
  outputGuidance: string;
  includeDiffSections: boolean;
  emphasizeArtifact: boolean;
}

const COMMON_VERDICT_ENVELOPE = `## Output format

Reply with a fenced JSON block first, then a brief prose explanation.

\`\`\`json
{
  "decision": "approve" | "request_changes" | "comment",
  "summary": "<one sentence overall assessment>",
  "comments": [
    {
      "severity": "CRITICAL|HIGH|MEDIUM|LOW",
      "category": "<profile-specific category>",
      "confidence": 0.95,
      "title": "short issue title",
      "rationale": "specific impact in plain language",
      "evidence": "verbatim snippet from the artifact or supporting evidence",
      "fix_hint": "optional concrete fix"
    }
  ]
}
\`\`\`

Decision rules:
- \`approve\`: no actionable issues and an empty \`comments\` array
- \`request_changes\`: any finding the author should address before advancing
- \`comment\`: avoid this for review loops; comments send the task back to the author

Every finding must include actionable rationale and verbatim evidence from the artifact or bounded supporting evidence supplied below.
Escape newlines inside JSON string values as \\n.

Do not modify files, commit, or push. Reviewers never change the workspace.`;

const CODE_STANDARDS = `## Review standards (code)

You are a senior engineer reviewing the author's work. The harness has already checked out their branch in the workspace above and attached diff summaries plus changed-file excerpts. Use that material first; read additional files in cwd only when you need surrounding context.

Focus findings on **changed lines** in the diff. Use the worktree to validate integration impact, test claims, and caller/callee relationships.

### Do not comment on

- Import/module path verification (IDEs and compilers catch these)
- Syntax or type errors (build and type checkers catch these)
- Style, formatting, or naming (linters/formatters handle these)
- Generic suggestions without concrete evidence ("consider adding error handling")
- Logging/debug statements unless sensitive data (tokens, PII, secrets) is logged
- Theoretical edge cases that assume broken system invariants without diff evidence

### Distinguish bugs from improvements

Flag as bugs: removals that break functionality, data loss, regressions, control-flow errors (unreachable code, double HTTP responses, missing return after response).

Do not flag as bugs: new error handling, defensive checks, logging, or fallback logic.

### Severity (only report confidence ≥ 0.85)

- CRITICAL: SQL injection, auth bypass, data loss, system crash, feature breakage
- HIGH: race conditions, memory leaks, breaking API changes, significant regressions
- MEDIUM: logic errors, missing validation, measurable performance issues
- LOW: minor edge cases with evident code improvement (use sparingly)

### Evidence rules

- Each finding must quote verbatim evidence from the diff or a changed-file excerpt above.
- Comment only on lines present in the diff.
- If you cannot point to exact evidence, skip the finding.
- Cross-check the author's handoff and task description, but do not approve without reading the attached diff.`;

const CODE_OUTPUT = `${COMMON_VERDICT_ENVELOPE}

Code-specific comment fields (include when applicable):
- \`file_path\`, \`start_line\`, \`end_line\`
- \`category\`: BUG|SECURITY|PERFORMANCE|ARCHITECTURE

Only include comments with confidence ≥ 0.85 and verbatim diff evidence.`;

const FRONTEND_STANDARDS = `## Review standards (frontend)

Review UI-facing changes with the same diff discipline as code, plus interaction, accessibility, and responsive behavior on changed surfaces.

Focus findings on **changed lines** in the diff and visible UI behavior tied to those changes.

### Additional checks

- Responsive layout regressions on narrow and wide viewports for touched components
- Accessibility for new/changed controls (labels, focus order, keyboard use)
- State handling for loading, empty, and error paths introduced in the diff

### Evidence rules

- Anchor each finding to changed code or stylesheet lines with verbatim diff evidence.
- Confidence ≥ 0.85 for actionable findings.`;

const FRONTEND_OUTPUT = `${COMMON_VERDICT_ENVELOPE}

Frontend-specific comment fields:
- \`file_path\`, \`start_line\`, \`end_line\`
- \`category\`: BUG|ACCESSIBILITY|RESPONSIVE|PERFORMANCE|ARCHITECTURE`;

const TECHNICAL_DOC_STANDARDS = `## Review standards (technical documentation)

Review the target artifact for accuracy, completeness, and operator usability. Use the author's final message and file excerpts as the primary artifact; verify claims against bounded supporting evidence when provided.

### Focus on

- Steps match the actual system behavior
- Commands, paths, and configuration names are correct
- Prerequisites, limitations, and rollback guidance are explicit
- Terminology is consistent with the product surface being documented

### Evidence rules

- Quote the exact passage that is unclear, incorrect, or missing context.
- Request source/fact verification for factual claims about behavior or metrics.`;

const CONTENT_STANDARDS = `## Review standards (content)

Review prose artifacts for clarity, structure, audience fit, and factual integrity. The author's final message and excerpts are the target artifact — do not apply code-diff rubrics.

### Focus on

- Narrative structure, hook, and call to action
- Claims that require source or fact verification
- Tone and terminology appropriate for the audience
- Unsupported superlatives or metrics without cited sources

### Evidence rules

- Quote the exact sentence or paragraph for each finding.
- Flag unsourced factual claims; do not attempt numeric reconciliation unless a source is cited.`;

const DATA_STANDARDS = `## Review standards (data)

Review analysis artifacts for methodological soundness and numeric integrity. The author's final message and excerpts are the target artifact.

### Focus on

- Methods, assumptions, and limitations are explicit
- Every metric, percentage, and count is reconciled against bounded supporting evidence
- Conclusions follow from the supplied data — reject unsupported numbers even when prose quality is high
- Charts/tables referenced in prose are internally consistent

### Evidence rules

- Quote the metric statement and the supporting evidence (or lack thereof).
- Request changes when a number cannot be derived from supplied evidence.`;

const DECISION_STANDARDS = `## Review standards (decision record)

Review decision artifacts for explicit options, tradeoffs, and consequences. Verify that recommendations follow from stated evidence.

### Focus on

- Problem framing and constraints are explicit
- Options considered with tradeoffs and risks
- Decision, rationale, and follow-up actions are actionable
- Factual claims cite bounded supporting evidence`;

const INCIDENT_STANDARDS = `## Review standards (incident)

Review incident artifacts for timeline accuracy, impact scope, mitigation steps, and follow-up actions.

### Focus on

- Timeline ordering and detection/mitigation milestones
- Customer or system impact is quantified with evidence
- Root cause vs contributing factors are distinguished
- Follow-up actions are concrete and owned`;

const SUPPORT_STANDARDS = `## Review standards (support)

Review customer-facing support responses for accuracy, tone, and policy compliance.

### Focus on

- Response answers the customer's question directly
- Policy commitments match documented support policy
- No speculative promises or undocumented refunds/credits
- Sensitive data handling and escalation paths are correct

### Evidence rules

- Quote the response passage and the policy or facts it must match.`;

const GENERIC_OUTPUT = COMMON_VERDICT_ENVELOPE;

export const REVIEW_PROFILES: Record<ReviewProfileId, ReviewProfileDefinition> = {
  code: {
    id: "code",
    label: "Code",
    standards: CODE_STANDARDS,
    outputGuidance: CODE_OUTPUT,
    includeDiffSections: true,
    emphasizeArtifact: false
  },
  frontend: {
    id: "frontend",
    label: "Frontend",
    standards: FRONTEND_STANDARDS,
    outputGuidance: FRONTEND_OUTPUT,
    includeDiffSections: true,
    emphasizeArtifact: false
  },
  "technical-doc": {
    id: "technical-doc",
    label: "Technical documentation",
    standards: TECHNICAL_DOC_STANDARDS,
    outputGuidance: GENERIC_OUTPUT,
    includeDiffSections: false,
    emphasizeArtifact: true
  },
  content: {
    id: "content",
    label: "Content",
    standards: CONTENT_STANDARDS,
    outputGuidance: GENERIC_OUTPUT,
    includeDiffSections: false,
    emphasizeArtifact: true
  },
  data: {
    id: "data",
    label: "Data analysis",
    standards: DATA_STANDARDS,
    outputGuidance: GENERIC_OUTPUT,
    includeDiffSections: false,
    emphasizeArtifact: true
  },
  decision: {
    id: "decision",
    label: "Decision record",
    standards: DECISION_STANDARDS,
    outputGuidance: GENERIC_OUTPUT,
    includeDiffSections: false,
    emphasizeArtifact: true
  },
  incident: {
    id: "incident",
    label: "Incident",
    standards: INCIDENT_STANDARDS,
    outputGuidance: GENERIC_OUTPUT,
    includeDiffSections: false,
    emphasizeArtifact: true
  },
  support: {
    id: "support",
    label: "Support response",
    standards: SUPPORT_STANDARDS,
    outputGuidance: GENERIC_OUTPUT,
    includeDiffSections: false,
    emphasizeArtifact: true
  }
};

export function resolveReviewProfile(step: WorkflowStep): ReviewProfileId {
  if (step.reviewProfile) return step.reviewProfile;
  return "code";
}

export function resolveReviewerIndependence(step: WorkflowStep, profile = resolveReviewProfile(step)): boolean {
  if (step.reviewerIndependence !== undefined) return step.reviewerIndependence;
  return PROFILE_CONSEQUENTIAL[profile];
}

export function getReviewProfileDefinition(profile: ReviewProfileId): ReviewProfileDefinition {
  return REVIEW_PROFILES[profile];
}
