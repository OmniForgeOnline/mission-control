export type SkillCategoryId = "loop" | "platform" | "engineering" | "domain" | "other";

export interface SkillCategory {
  id: SkillCategoryId;
  label: string;
  order: number;
}

const SKILL_CATEGORIES: SkillCategory[] = [
  { id: "loop", label: "Agent loop", order: 0 },
  { id: "platform", label: "Harness platform", order: 1 },
  { id: "engineering", label: "Code & delivery", order: 2 },
  { id: "domain", label: "Domain workflows", order: 3 },
  { id: "other", label: "Other", order: 4 }
];

const SKILL_CATEGORY_BY_NAME: Record<string, SkillCategoryId> = {
  "harness-turn-loop": "loop",
  "operator-handoff": "loop",
  "debug-prior-runs": "loop",

  "proposal-first": "platform",
  "harness-memory": "platform",
  "harness-skill-author": "platform",
  "tech-debt-capture": "platform",
  "harness-checks": "platform",
  "harness-quality": "platform",

  "pr-driven-execution": "engineering",
  "code-review": "engineering",
  "frontend-qa": "engineering",
  "technical-investigation": "engineering",
  "infrastructure-change": "engineering",
  "release-readiness": "engineering",

  "content-production": "domain",
  "product-discovery": "domain",
  "customer-support-triage": "domain",
  "data-analysis": "domain",
  "incident-response": "domain",
  "seo-growth": "domain"
};

const CATEGORY_BY_ID = new Map(SKILL_CATEGORIES.map((category) => [category.id, category]));

export function resolveSkillCategory(name: string, frontmatterCategory?: string): SkillCategory {
  const normalized = frontmatterCategory?.trim().toLowerCase();
  if (normalized) {
    const byId = CATEGORY_BY_ID.get(normalized as SkillCategoryId);
    if (byId) return byId;
    const byLabel = SKILL_CATEGORIES.find((category) => category.label.toLowerCase() === normalized);
    if (byLabel) return byLabel;
  }

  const mapped = SKILL_CATEGORY_BY_NAME[name];
  if (mapped) return CATEGORY_BY_ID.get(mapped)!;

  if (name.startsWith("harness-")) {
    return CATEGORY_BY_ID.get("platform")!;
  }

  return CATEGORY_BY_ID.get("other")!;
}

export function groupSkillsByCategory<T extends { name: string; category: SkillCategoryId }>(
  skills: T[]
): Array<{ category: SkillCategory; skills: T[] }> {
  const buckets = new Map<SkillCategoryId, T[]>();
  for (const skill of skills) {
    const list = buckets.get(skill.category) ?? [];
    list.push(skill);
    buckets.set(skill.category, list);
  }

  return SKILL_CATEGORIES.flatMap((category) => {
    const group = buckets.get(category.id);
    if (!group?.length) return [];
    return [{ category, skills: group }];
  });
}