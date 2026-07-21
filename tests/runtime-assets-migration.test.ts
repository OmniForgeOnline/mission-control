import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { DEFAULT_SKILLS } from "../src/core/bootstrap/defaults/skills.ts";
import { readSkill } from "../src/core/catalog/skills-catalog.ts";
import { bundledSkillHash, bundledSkillIds } from "../src/core/bootstrap/runtime-assets/bundled.ts";
import {
  diffRuntimeAsset,
  inspectRuntimeAssets,
  keepRuntimeAsset,
  migrateRuntimeAssets,
  readRuntimeAssetsManifest,
  resetRuntimeAsset,
  runtimeAssetBackupDir,
  workflowBundledHash
} from "../src/core/bootstrap/runtime-assets/index.ts";
import { hashBody } from "../src/core/inventory/hash.ts";
import {
  assertWorkflowSkillReferences,
  findMissingWorkflowSkillReferences
} from "../src/core/workflows/skill-validation.ts";
import {
  ensureWorkflowFiles,
  loadWorkflow,
  resetWorkflowCache,
  workflowFilePath
} from "../src/core/workflows/cache.ts";
import { bundledWorkflowsDir } from "../src/core/workflows/paths.ts";
import { validateWorkflow } from "../src/core/workflows/validate.ts";
import { parse as parseYaml } from "yaml";

describe("runtime assets migration", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-runtime-assets-"));
    resetWorkflowCache();
  });

  afterEach(async () => {
    resetWorkflowCache();
    await rm(root, { recursive: true, force: true });
  });

  it("fresh install seeds bundled workflows, skills, and manifest hashes", async () => {
    await ensureHarnessRepository(root);

    const manifest = await readRuntimeAssetsManifest(root);
    expect(Object.keys(manifest.workflows).length).toBeGreaterThan(0);
    expect(manifest.skills["pr-driven-execution"]?.bundledHash).toBeTruthy();
    expect(manifest.skills["harness-quality"]?.bundledHash).toBeTruthy();

    const codeFeature = await readFile(workflowFilePath(root, "code-feature"), "utf8");
    const bundled = await readFile(path.join(bundledWorkflowsDir(), "code-feature.yml"), "utf8");
    expect(await workflowBundledHash(codeFeature)).toBe(await workflowBundledHash(bundled));

    const prSkill = await readFile(path.join(root, "skills", "pr-driven-execution", "SKILL.md"), "utf8");
    expect(hashBody(prSkill)).toBe(hashBody(DEFAULT_SKILLS["pr-driven-execution/SKILL.md"]!));
    expect(prSkill).toContain("commit, and push the task branch yourself");
  });

  it("auto-upgrades an unchanged old install when bundled content changes", async () => {
    await ensureHarnessRepository(root);
    const bundledPath = path.join(bundledWorkflowsDir(), "code-feature.yml");
    const bundled = await readFile(bundledPath, "utf8");
    const oldText = bundled.replace("name: Code Feature", "name: Code Feature Legacy");
    const oldHash = await workflowBundledHash(oldText);

    await writeFile(workflowFilePath(root, "code-feature"), oldText, "utf8");
    const manifest = await readRuntimeAssetsManifest(root);
    manifest.workflows["code-feature"] = { bundledHash: oldHash, updatedAt: "2020-01-01T00:00:00.000Z" };
    await writeFile(
      path.join(root, "data", "state", "runtime-assets-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8"
    );
    resetWorkflowCache();

    const result = await migrateRuntimeAssets(root);
    expect(result.upgraded.workflows).toContain("code-feature");

    const runtime = await readFile(workflowFilePath(root, "code-feature"), "utf8");
    expect(runtime).toContain("name: Code Feature");
    expect(runtime).not.toContain("Code Feature Legacy");

    const updated = await readRuntimeAssetsManifest(root);
    expect(updated.workflows["code-feature"]?.bundledHash).toBe(await workflowBundledHash(bundled));
  });

  it("never overwrites a customized workflow without explicit reset", async () => {
    await ensureHarnessRepository(root);
    const bundled = await readFile(path.join(bundledWorkflowsDir(), "bugfix.yml"), "utf8");
    const customized = bundled.replace("name: Bugfix", "name: Operator Bugfix");
    await writeFile(workflowFilePath(root, "bugfix"), customized, "utf8");
    const manifest = await readRuntimeAssetsManifest(root);
    manifest.workflows["bugfix"] = {
      bundledHash: await workflowBundledHash(bundled),
      updatedAt: "2020-01-01T00:00:00.000Z"
    };
    await writeFile(
      path.join(root, "data", "state", "runtime-assets-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8"
    );
    resetWorkflowCache();

    const result = await migrateRuntimeAssets(root);
    expect(result.pendingReview.workflows).toContain("bugfix");
    expect(result.upgraded.workflows).not.toContain("bugfix");

    const runtime = await readFile(workflowFilePath(root, "bugfix"), "utf8");
    expect(runtime).toContain("Operator Bugfix");
  });

  it("never overwrites a customized workflow when manifest entry is missing", async () => {
    await ensureHarnessRepository(root);
    const bundled = await readFile(path.join(bundledWorkflowsDir(), "bugfix.yml"), "utf8");
    const customized = bundled.replace("name: Bugfix", "name: Operator Bugfix");
    await writeFile(workflowFilePath(root, "bugfix"), customized, "utf8");
    const manifest = await readRuntimeAssetsManifest(root);
    delete manifest.workflows["bugfix"];
    await writeFile(
      path.join(root, "data", "state", "runtime-assets-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8"
    );
    resetWorkflowCache();

    const result = await migrateRuntimeAssets(root);
    expect(result.pendingReview.workflows).toContain("bugfix");
    expect(result.upgraded.workflows).not.toContain("bugfix");

    const runtime = await readFile(workflowFilePath(root, "bugfix"), "utf8");
    expect(runtime).toContain("Operator Bugfix");

    const updated = await readRuntimeAssetsManifest(root);
    expect(updated.workflows["bugfix"]?.bundledHash).toBe(await workflowBundledHash(customized));
  });

  it("never overwrites a customized skill when manifest entry is missing", async () => {
    await ensureHarnessRepository(root);
    const skillPath = path.join(root, "skills", "harness-checks", "SKILL.md");
    const customized = `${await readFile(skillPath, "utf8")}\n\n## Operator note\n`;
    await writeFile(skillPath, customized, "utf8");
    const manifest = await readRuntimeAssetsManifest(root);
    delete manifest.skills["harness-checks"];
    await writeFile(
      path.join(root, "data", "state", "runtime-assets-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8"
    );

    const result = await migrateRuntimeAssets(root);
    expect(result.pendingReview.skills).toContain("harness-checks");
    expect(result.upgraded.skills).not.toContain("harness-checks");
    expect(await readFile(skillPath, "utf8")).toContain("Operator note");

    const updated = await readRuntimeAssetsManifest(root);
    expect(updated.skills["harness-checks"]?.bundledHash).toBe(hashBody(customized));
  });

  it("reviews unchanged-old workflow without manifest until reset", async () => {
    await ensureHarnessRepository(root);
    const bundledPath = path.join(bundledWorkflowsDir(), "code-feature.yml");
    const bundled = await readFile(bundledPath, "utf8");
    const oldText = bundled.replace("name: Code Feature", "name: Code Feature Legacy");
    const oldHash = await workflowBundledHash(oldText);
    await writeFile(workflowFilePath(root, "code-feature"), oldText, "utf8");
    const manifest = await readRuntimeAssetsManifest(root);
    delete manifest.workflows["code-feature"];
    await writeFile(
      path.join(root, "data", "state", "runtime-assets-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8"
    );
    resetWorkflowCache();

    const first = await migrateRuntimeAssets(root);
    expect(first.pendingReview.workflows).toContain("code-feature");
    expect(first.upgraded.workflows).not.toContain("code-feature");
    expect(await readFile(workflowFilePath(root, "code-feature"), "utf8")).toBe(oldText);

    const mid = await readRuntimeAssetsManifest(root);
    expect(mid.workflows["code-feature"]?.bundledHash).toBe(oldHash);
    expect(mid.workflows["code-feature"]?.pendingReview).toBe(true);

    const second = await migrateRuntimeAssets(root);
    expect(second.pendingReview.workflows).toContain("code-feature");
    expect(second.upgraded.workflows).not.toContain("code-feature");
    expect(await readFile(workflowFilePath(root, "code-feature"), "utf8")).toBe(oldText);

    await resetRuntimeAsset(root, "workflow", "code-feature");
    expect(await readFile(workflowFilePath(root, "code-feature"), "utf8")).toContain("name: Code Feature");
  });

  it("preserves review-baselined customizations across boot migrate passes", async () => {
    await ensureHarnessRepository(root);
    const bundled = await readFile(path.join(bundledWorkflowsDir(), "bugfix.yml"), "utf8");
    const customized = bundled.replace("name: Bugfix", "name: Operator Bugfix");
    await writeFile(workflowFilePath(root, "bugfix"), customized, "utf8");
    const manifest = await readRuntimeAssetsManifest(root);
    delete manifest.workflows["bugfix"];
    await writeFile(
      path.join(root, "data", "state", "runtime-assets-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8"
    );
    resetWorkflowCache();

    await ensureHarnessRepository(root);
    await ensureWorkflowFiles(root);

    const runtime = await readFile(workflowFilePath(root, "bugfix"), "utf8");
    expect(runtime).toContain("Operator Bugfix");

    const updated = await readRuntimeAssetsManifest(root);
    expect(updated.workflows["bugfix"]?.pendingReview).toBe(true);

    const inspected = await inspectRuntimeAssets(root);
    expect(inspected.pendingReview.workflows).toContain("bugfix");
    expect(inspected.upgraded.workflows).not.toContain("bugfix");
  });

  it("keepRuntimeAsset pins customized workflow against later migrate", async () => {
    await ensureHarnessRepository(root);
    const bundled = await readFile(path.join(bundledWorkflowsDir(), "bugfix.yml"), "utf8");
    const customized = bundled.replace("name: Bugfix", "name: Operator Bugfix");
    await writeFile(workflowFilePath(root, "bugfix"), customized, "utf8");
    const manifest = await readRuntimeAssetsManifest(root);
    delete manifest.workflows["bugfix"];
    await writeFile(
      path.join(root, "data", "state", "runtime-assets-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8"
    );
    resetWorkflowCache();

    const before = await migrateRuntimeAssets(root);
    expect(before.pendingReview.workflows).toContain("bugfix");

    const kept = await keepRuntimeAsset(root, "workflow", "bugfix");
    expect(kept.bundledHash).toBe(await workflowBundledHash(customized));

    const afterKeep = await readRuntimeAssetsManifest(root);
    expect(afterKeep.workflows["bugfix"]?.kept).toBe(true);
    expect(afterKeep.workflows["bugfix"]?.pendingReview).toBeUndefined();

    const afterMigrate = await migrateRuntimeAssets(root);
    expect(afterMigrate.pendingReview.workflows).not.toContain("bugfix");
    expect(afterMigrate.upgraded.workflows).not.toContain("bugfix");
    expect(await readFile(workflowFilePath(root, "bugfix"), "utf8")).toContain("Operator Bugfix");

    const finalManifest = await readRuntimeAssetsManifest(root);
    expect(finalManifest.workflows["bugfix"]?.kept).toBe(true);
    expect(finalManifest.workflows["bugfix"]?.bundledHash).toBe(await workflowBundledHash(customized));
  });

  it("keepRuntimeAsset clears pending review for a customized workflow", async () => {
    await ensureHarnessRepository(root);
    const bundled = await readFile(path.join(bundledWorkflowsDir(), "bugfix.yml"), "utf8");
    const customized = bundled.replace("name: Bugfix", "name: Operator Bugfix");
    await writeFile(workflowFilePath(root, "bugfix"), customized, "utf8");
    const manifest = await readRuntimeAssetsManifest(root);
    manifest.workflows["bugfix"] = {
      bundledHash: await workflowBundledHash(bundled),
      updatedAt: "2020-01-01T00:00:00.000Z"
    };
    await writeFile(
      path.join(root, "data", "state", "runtime-assets-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8"
    );
    resetWorkflowCache();

    const before = await migrateRuntimeAssets(root);
    expect(before.pendingReview.workflows).toContain("bugfix");

    const kept = await keepRuntimeAsset(root, "workflow", "bugfix");
    expect(kept.bundledHash).toBe(await workflowBundledHash(customized));

    const after = await inspectRuntimeAssets(root);
    expect(after.pendingReview.workflows).not.toContain("bugfix");
    expect(await readFile(workflowFilePath(root, "bugfix"), "utf8")).toContain("Operator Bugfix");

    const pinned = await readRuntimeAssetsManifest(root);
    expect(pinned.workflows["bugfix"]?.kept).toBe(true);
  });

  it("leaves runtime-only workflows and skills untouched", async () => {
    await ensureHarnessRepository(root);
    await writeFile(
      path.join(root, "workflows", "operator-only.yml"),
      `id: operator-only
name: Operator Only
initial: done
defaults:
  agents:
    author: claude
    reviewer: codex
steps:
  done:
    kind: terminal
    agent: none
    approval: none
`,
      "utf8"
    );
    await mkdir(path.join(root, "skills", "operator-skill"), { recursive: true });
    await writeFile(
      path.join(root, "skills", "operator-skill", "SKILL.md"),
      `---
name: operator-skill
description: Operator-authored skill.
---

# Operator Skill
`,
      "utf8"
    );

    const result = await migrateRuntimeAssets(root);
    expect(result.untouched.workflows).toContain("operator-only");
    expect(result.untouched.skills).toContain("operator-skill");
    expect(await readFile(path.join(root, "skills", "operator-skill", "SKILL.md"), "utf8")).toContain(
      "Operator Skill"
    );
  });

  it("preserves runtime copies of removed bundled workflows", async () => {
    await ensureHarnessRepository(root);
    const legacyPath = path.join(root, "workflows", "retired-flow.yml");
    const legacyBody = `id: retired-flow
name: Retired Flow
initial: done
defaults:
  agents:
    author: claude
    reviewer: codex
steps:
  done:
    kind: terminal
    agent: none
    approval: none
`;
    await writeFile(legacyPath, legacyBody, "utf8");

    const result = await migrateRuntimeAssets(root);
    expect(result.untouched.workflows).toContain("retired-flow");
    expect(await readFile(legacyPath, "utf8")).toBe(legacyBody);
  });

  it("records a backup and bundled body when resetting a customized skill", async () => {
    await ensureHarnessRepository(root);
    const skillPath = path.join(root, "skills", "harness-checks", "SKILL.md");
    const customized = `${await readFile(skillPath, "utf8")}\n\n## Operator note\n`;
    await writeFile(skillPath, customized, "utf8");

    const diff = await diffRuntimeAsset(root, "skill", "harness-checks");
    expect(diff.status).toBe("runtime-customized");
    expect(diff.runtimeBody).toContain("Operator note");
    expect(diff.bundledBody).toBeTruthy();

    const reset = await resetRuntimeAsset(root, "skill", "harness-checks");
    expect(reset.backupPath).toContain(runtimeAssetBackupDir(root));
    expect(await readFile(skillPath, "utf8")).toBe(diff.bundledBody);
    expect(await readFile(reset.backupPath, "utf8")).toBe(customized);
  });

  it("fresh install seeds packaged workflow-referenced skills at runtime", async () => {
    await ensureHarnessRepository(root);

    expect(bundledSkillIds()).toContain("technical-investigation");
    expect(bundledSkillIds()).toContain("content-production");

    const bugfix = await loadWorkflow(root, "bugfix");
    await expect(assertWorkflowSkillReferences(root, bugfix)).resolves.toBeUndefined();
    const skill = await readSkill(root, "technical-investigation");
    expect(skill.name).toBe("technical-investigation");
    expect(skill.content).toContain("technical-investigation");
  });

  it("auto-upgrades a real v0.8 install without a manifest", async () => {
    await ensureHarnessRepository(root);
    const workflowPath = workflowFilePath(root, "bugfix");
    const oldBody = await readFile(path.join(process.cwd(), "tests", "fixtures", "bugfix-v0.8.yml"), "utf8");
    const oldHash = await workflowBundledHash(oldBody);
    await writeFile(workflowPath, oldBody, "utf8");
    await rm(path.join(root, "data", "state", "runtime-assets-manifest.json"));

    const result = await migrateRuntimeAssets(root);
    expect(result.upgraded.workflows).toContain("bugfix");
    expect(await workflowBundledHash(await readFile(workflowPath, "utf8"))).not.toBe(oldHash);

    const updated = await readRuntimeAssetsManifest(root);
    expect(updated.workflows["bugfix"]?.priorBundledHash).toBe(oldHash);
    expect(updated.workflows["bugfix"]?.bundledBodyHistory?.[oldHash]).toBe(oldBody);
  });

  it("diffRuntimeAsset exposes prior bundled, runtime, and current bundled bodies", async () => {
    await ensureHarnessRepository(root);
    const skillPath = path.join(root, "skills", "harness-checks", "SKILL.md");
    const customized = `${await readFile(skillPath, "utf8")}\n\n## Operator note\n`;
    await writeFile(skillPath, customized, "utf8");
    const manifest = await readRuntimeAssetsManifest(root);
    manifest.skills["harness-checks"] = {
      bundledHash: bundledSkillHash(customized),
      priorBundledHash: bundledSkillHash(DEFAULT_SKILLS["harness-checks/SKILL.md"]!),
      updatedAt: "2020-01-01T00:00:00.000Z",
      pendingReview: true
    };
    await writeFile(
      path.join(root, "data", "state", "runtime-assets-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8"
    );

    const diff = await diffRuntimeAsset(root, "skill", "harness-checks");
    expect(diff.runtimeBody).toContain("Operator note");
    expect(diff.bundledBody).toContain("# Harness Checks");
    expect(diff.priorBundledHash).toBeTruthy();
    expect(diff.priorBundledBody).toContain("# Harness Checks");
  });

  it("uses the installed v2 body as the common ancestor for a v3 comparison", async () => {
    await ensureHarnessRepository(root);
    const skillPath = path.join(root, "skills", "harness-checks", "SKILL.md");
    const currentV3 = DEFAULT_SKILLS["harness-checks/SKILL.md"]!;
    const installedV2 = currentV3.replace("# Harness Checks", "# Harness Checks v2");
    const customizedV2 = `${installedV2}\n\n## Local v2 note\n`;
    await writeFile(skillPath, customizedV2, "utf8");
    const manifest = await readRuntimeAssetsManifest(root);
    manifest.skills["harness-checks"] = {
      bundledHash: bundledSkillHash(installedV2),
      bundledBody: installedV2,
      updatedAt: "2020-01-01T00:00:00.000Z"
    };
    await writeFile(
      path.join(root, "data", "state", "runtime-assets-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8"
    );

    const diff = await diffRuntimeAsset(root, "skill", "harness-checks");
    expect(diff.bundledBody).toBe(currentV3);
    expect(diff.runtimeBody).toBe(customizedV2);
    expect(diff.priorBundledHash).toBe(bundledSkillHash(installedV2));
    expect(diff.priorBundledBody).toBe(installedV2);
  });

  it("validation fails when a workflow skill is packaged but missing from runtime", async () => {
    await ensureHarnessRepository(root);
    await rm(path.join(root, "skills", "technical-investigation"), { recursive: true, force: true });
    resetWorkflowCache();
    const bugfix = validateWorkflow(
      parseYaml(await readFile(path.join(bundledWorkflowsDir(), "bugfix.yml"), "utf8"))
    );
    const missing = await findMissingWorkflowSkillReferences(root, bugfix);
    expect(missing).toContain("technical-investigation");
    await expect(assertWorkflowSkillReferences(root, bugfix)).rejects.toThrow("technical-investigation");
  });

  it("leaves manifest and runtime unchanged when a bundled write fails", async () => {
    await ensureHarnessRepository(root);
    const bundled = await readFile(path.join(bundledWorkflowsDir(), "technical-debt.yml"), "utf8");
    const oldText = bundled.replace("name: Technical Debt", "name: Technical Debt Legacy");
    const oldHash = await workflowBundledHash(oldText);
    const target = workflowFilePath(root, "technical-debt");
    await writeFile(target, oldText, "utf8");
    const manifest = await readRuntimeAssetsManifest(root);
    manifest.workflows["technical-debt"] = { bundledHash: oldHash, updatedAt: "2020-01-01T00:00:00.000Z" };
    const manifestPath = path.join(root, "data", "state", "runtime-assets-manifest.json");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await chmod(target, 0o444);

    try {
      const result = await migrateRuntimeAssets(root);
      expect(result.errors.some((entry) => entry.id === "technical-debt")).toBe(true);
      expect(await readFile(target, "utf8")).toBe(oldText);
      const reloaded = await readRuntimeAssetsManifest(root);
      expect(reloaded.workflows["technical-debt"]?.bundledHash).toBe(oldHash);
    } finally {
      await chmod(target, 0o644);
    }
  });
});
