const FINAL_ANSWER_MARKERS = [
  /\bdone\b/i,
  /\bcompleted\b/i,
  /\bship(?:ped)?\b/i,
  /\bno (?:further|more) (?:action|work) (?:needed|required)\b/i,
  /\bfinal answer\b/i,
  /\*\*Pushed\.\*\*/i,
  /\*\*Changed\.\*\*/i
];
const QUESTION_MARKERS = [/\?\s*$/, /\bplease confirm\b/i, /\bwhich (?:would|do) you/i];
const CHOICE_MARKERS = [
  /\b(?:or|but)\s+(?:happy|glad|willing|can|could)\s+to\b/i,
  /\bready to \w+.*\bor\b/i,
  /\bif you'?d like\b/i,
  /\bcan adjust if\b/i,
];

export function looksLikeFinalAnswer(reply: string): boolean {
  if (!reply) return false;
  if (QUESTION_MARKERS.some((re) => re.test(reply))) return false;
  if (CHOICE_MARKERS.some((re) => re.test(reply))) return false;
  return FINAL_ANSWER_MARKERS.some((re) => re.test(reply));
}