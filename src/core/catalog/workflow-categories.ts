export type WorkflowCategoryId = "engineering" | "data" | "content" | "ops" | "other";

export interface WorkflowCategory {
  id: WorkflowCategoryId;
  label: string;
  order: number;
}

const WORKFLOW_CATEGORIES: WorkflowCategory[] = [
  { id: "engineering", label: "Engineering", order: 0 },
  { id: "data", label: "Data & research", order: 1 },
  { id: "content", label: "Content", order: 2 },
  { id: "ops", label: "Operations", order: 3 },
  { id: "other", label: "Other", order: 4 }
];

const WORKFLOW_CATEGORY_BY_ID: Record<string, WorkflowCategoryId> = {
  "code-feature": "engineering",
  bugfix: "engineering",
  "frontend-ui-change": "engineering",
  "infrastructure-change": "engineering",
  "technical-debt": "engineering",

  "data-analysis": "data",
  "ux-research": "data",
  "seo-investigation": "data",

  "write-document": "content",
  "blog-post": "content",
  "marketing-asset": "content",
  "docs-update": "content",
  "product-spec": "content",

  "incident-response": "ops",
  "customer-support": "ops"
};

const CATEGORY_BY_ID = new Map(WORKFLOW_CATEGORIES.map((category) => [category.id, category]));

export function resolveWorkflowCategory(id: string): WorkflowCategory {
  const mapped = WORKFLOW_CATEGORY_BY_ID[id];
  if (mapped) return CATEGORY_BY_ID.get(mapped)!;
  return CATEGORY_BY_ID.get("other")!;
}

export function groupWorkflowsByCategory<T extends { id: string }>(
  workflows: T[]
): Array<{ category: WorkflowCategory; workflows: T[] }> {
  const buckets = new Map<WorkflowCategoryId, T[]>();
  for (const workflow of workflows) {
    const categoryId = resolveWorkflowCategory(workflow.id).id;
    const list = buckets.get(categoryId) ?? [];
    list.push(workflow);
    buckets.set(categoryId, list);
  }

  return WORKFLOW_CATEGORIES.flatMap((category) => {
    const group = buckets.get(category.id);
    if (!group?.length) return [];
    return [{ category, workflows: group }];
  });
}
