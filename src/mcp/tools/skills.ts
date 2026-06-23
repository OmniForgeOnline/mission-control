import { listSkills, readSkill } from "../../core/catalog/skills-catalog.ts";
import type { McpToolModule } from "../types.ts";
import { asText } from "../types.ts";

export const skillTools: McpToolModule = {
  definitions: [
    {
      name: "list_skills",
      description: "List approved harness skills with their one-sentence descriptions.",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "read_skill",
      description: "Load a skill body on demand. Skills are not inlined into the turn prompt.",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] }
    }
  ],
  handlers: {
    list_skills: async (ctx) => asText(await listSkills(ctx.root)),
    read_skill: async (ctx, args) => asText(await readSkill(ctx.root, String(args["name"]).trim()))
  }
};