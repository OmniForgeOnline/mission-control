import { buildInitialPrompt } from "../src/daemon/prompts.ts";
import { attachmentFilePath } from "../src/core/attachments/paths.ts";
import type { HarnessAttachment, HarnessTask } from "../src/core/types.ts";
import type { PreparedWorkspace } from "../src/core/worktrees/worktrees.ts";

function baseTask(overrides: Partial<HarnessTask> = {}): HarnessTask {
  return {
    id: "9b4de099-a5ff-40e0-9410-86cca1902b7e",
    title: "Fix worktree branch naming",
    description: "## Goal\nUse short task ids in harness branch names.",
    agent: "grok",
    source: "manual",
    links: [],
    targets: [],
    messages: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

const workspace: PreparedWorkspace = { cwd: "/tmp/worktree", isRepo: false, created: false };

describe("buildInitialPrompt task-level attachments", () => {
  const root = "/harness";

  it("surfaces ticket-level attachment references so a fresh ticket's first turn can read them", () => {
    const attachments: HarnessAttachment[] = [
      {
        id: "att-1",
        filename: "brief.pdf",
        mimeType: "application/pdf",
        size: 2048,
        source: "intake",
        createdAt: "2026-01-01T00:00:00.000Z"
      },
      {
        id: "att-2",
        filename: "screenshot.png",
        mimeType: "image/png",
        size: 4096,
        source: "clickup",
        sourceUrl: "https://clickup.example/brief.png",
        sourceKey: "clickup:cu-1:att-2",
        createdAt: "2026-01-01T00:00:00.000Z"
      }
    ];
    const prompt = buildInitialPrompt(
      root,
      baseTask({ attachments }),
      "",
      workspace
    );

    for (const attachment of attachments) {
      expect(prompt).toContain(attachmentFilePath(root, attachment.id));
      expect(prompt).toContain(attachment.filename);
      expect(prompt).toContain(`${attachment.size} bytes`);
      expect(prompt).toContain(attachment.mimeType);
    }
  });

  it("omits any attachment block when the ticket has no attachments", () => {
    const prompt = buildInitialPrompt(root, baseTask(), "", workspace);
    expect(prompt).not.toContain("Attachments:");
  });
});
