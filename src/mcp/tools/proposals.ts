import path from "node:path";

import { createProposal } from "../../core/proposals/proposals.ts";
import { updateJsonFile } from "../../core/infra/fs.ts";
import type { CreateProposalInput } from "../../core/types.ts";
import type { McpToolModule } from "../types.ts";
import { asText } from "../types.ts";

const PROPOSAL_WORKFLOW_PROPERTY = {
  workflowId: {
    type: "string",
    description: "Optional workflow id (defaults to the harness default, same as createTask)."
  }
} as const;

function proposalWorkflowId(args: Record<string, unknown>): string | undefined {
  return typeof args["workflowId"] === "string" && args["workflowId"].trim() ? args["workflowId"].trim() : undefined;
}

function withProposalWorkflow(
  input: Omit<CreateProposalInput, "workflowId">,
  args: Record<string, unknown>
): CreateProposalInput {
  const workflowId = proposalWorkflowId(args);
  return workflowId ? { ...input, workflowId } : input;
}

interface TechDebtItem {
  id: string;
  title: string;
  description: string;
  agent?: "codex" | "claude";
  targets?: Array<{ raw: string; path: string; kind: "file" | "directory" }>;
  status?: "open" | "closed" | "queued";
  queuedTaskId?: string;
  capturedAt?: string;
  capturedBy?: string;
  projectId?: string;
}

function uuid(): string {
  return `td_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export const proposalTools: McpToolModule = {
  definitions: [
    {
      name: "propose_rule",
      description:
        "Queue a harness change ticket for a kernel/* file. Creates a normal task (source: manual) like operator intake.",
      inputSchema: {
        type: "object",
        properties: {
          targetPath: { type: "string", description: "Relative to harness root, e.g. kernel/operating-principles.md" },
          title: { type: "string" },
          rationale: { type: "string" },
          content: { type: "string" },
          ...PROPOSAL_WORKFLOW_PROPERTY
        },
        required: ["targetPath", "title", "rationale", "content"]
      }
    },
    {
      name: "propose_skill",
      description:
        "Queue a harness change ticket for skills/<name>/SKILL.md. Creates a normal task (source: manual).",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Folder name under skills/, lowercase-dash." },
          description: { type: "string", description: "One-sentence skill description for the index." },
          body: { type: "string", description: "Full SKILL.md body (without frontmatter — we add it)." },
          rationale: { type: "string" },
          ...PROPOSAL_WORKFLOW_PROPERTY
        },
        required: ["name", "description", "body", "rationale"]
      }
    },
    {
      name: "propose_hook",
      description: "Queue a harness change ticket for hooks/<name>.md or hooks/<name>.ts. Creates a normal task (source: manual).",
      inputSchema: {
        type: "object",
        properties: {
          targetPath: { type: "string" },
          title: { type: "string" },
          rationale: { type: "string" },
          content: { type: "string" },
          ...PROPOSAL_WORKFLOW_PROPERTY
        },
        required: ["targetPath", "title", "rationale", "content"]
      }
    },
    {
      name: "tech_debt_capture",
      description:
        "Append an item to state/tech-debt.json. The autonomy tech-debt-sweep job will queue a synthetic task for it.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          agent: { type: "string", description: "codex or claude" },
          targets: {
            type: "array",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                kind: { type: "string", enum: ["file", "directory"] }
              },
              required: ["path", "kind"]
            }
          },
          projectId: { type: "string", description: "Optional project ID to scope this debt item to a specific onboarded project." }
        },
        required: ["title", "description"]
      }
    }
  ],
  handlers: {
    propose_rule: async (ctx, args) => {
      const proposal = await createProposal(
        ctx.root,
        withProposalWorkflow(
          {
            kind: "rule",
            targetPath: String(args["targetPath"]),
            title: String(args["title"]),
            rationale: String(args["rationale"]),
            content: String(args["content"])
          },
          args
        )
      );
      return asText({ id: proposal.id, status: proposal.status, targetPath: proposal.targetPath });
    },
    propose_skill: async (ctx, args) => {
      const skillName = String(args["name"]).trim();
      if (!/^[a-z][a-z0-9-]*$/.test(skillName)) {
        throw new Error("Skill name must be lowercase-dash (e.g. 'pr-driven-execution').");
      }
      const description = String(args["description"]);
      const body = String(args["body"]);
      const rationale = String(args["rationale"]);
      const frontmatter = `---\nname: ${skillName}\ndescription: ${description}\n---\n\n`;
      const proposal = await createProposal(
        ctx.root,
        withProposalWorkflow(
          {
            kind: "skill",
            targetPath: `skills/${skillName}/SKILL.md`,
            title: `Skill: ${skillName}`,
            rationale,
            content: `${frontmatter}${body.trim()}\n`
          },
          args
        )
      );
      return asText({ id: proposal.id, status: proposal.status, targetPath: proposal.targetPath });
    },
    propose_hook: async (ctx, args) => {
      const proposal = await createProposal(
        ctx.root,
        withProposalWorkflow(
          {
            kind: "hook",
            targetPath: String(args["targetPath"]),
            title: String(args["title"]),
            rationale: String(args["rationale"]),
            content: String(args["content"])
          },
          args
        )
      );
      return asText({ id: proposal.id, status: proposal.status, targetPath: proposal.targetPath });
    },
    tech_debt_capture: async (ctx, args) => {
      const projectId = typeof args["projectId"] === "string" ? args["projectId"] : undefined;
      let ledgerPath = path.join(ctx.root, "data", "state", "tech-debt.json");

      if (projectId) {
        const { getProject, projectDir } = await import("../../core/projects/registry.ts");
        const project = await getProject(ctx.root, projectId);
        if (!project) throw new Error(`Project not found: ${projectId}`);
        const { ensureDir } = await import("../../core/infra/fs.ts");
        const dir = projectDir(ctx.root, projectId);
        await ensureDir(dir);
        ledgerPath = path.join(dir, "tech-debt.json");
      }

      const agent =
        typeof args["agent"] === "string" && (args["agent"] === "codex" || args["agent"] === "claude")
          ? args["agent"]
          : undefined;
      const targets = Array.isArray(args["targets"])
        ? args["targets"].map((t: { path?: unknown; kind?: unknown }) => ({
            raw: `@${t.path}`,
            path: String(t.path),
            kind: t.kind === "file" ? ("file" as const) : ("directory" as const)
          }))
        : undefined;
      const item: TechDebtItem = {
        id: uuid(),
        title: String(args["title"]),
        description: String(args["description"]),
        status: "open",
        capturedAt: new Date().toISOString(),
        capturedBy: ctx.runId,
        ...(agent ? { agent } : {}),
        ...(targets ? { targets } : {}),
        ...(projectId ? { projectId } : {})
      };
      const items = await updateJsonFile<TechDebtItem[]>(ledgerPath, [], (current) => {
        current.push(item);
        return current;
      });
      return asText({ id: item.id, status: item.status, total: items.length, ...(projectId ? { projectId } : {}) });
    }
  }
};