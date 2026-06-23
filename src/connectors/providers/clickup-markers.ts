const TRIGGER_PATTERN = /(^|[^\w])@omc\b/i;

export interface ClickUpCommentTriggerCandidate {
  text: string;
  authorId?: string;
}

export function textContainsHarnessTrigger(text: string | undefined): boolean {
  return TRIGGER_PATTERN.test(text ?? "");
}

export function commentContainsHarnessTrigger(
  comment: ClickUpCommentTriggerCandidate,
  _integrationUserId?: string
): boolean {
  return textContainsHarnessTrigger(comment.text);
}
