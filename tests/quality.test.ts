import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildQualityGateRemediation,
  computeQualityGrades,
  domainsBelowGrade,
  qualityGateTaskTitle
} from "../src/core/quality/quality.ts";
import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";

describe("quality grades", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-quality-"));
    await ensureHarnessRepository(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("grades domains without tests below A and sorts worst first", async () => {
    await mkdir(path.join(root, "src", "core"), { recursive: true });
    await mkdir(path.join(root, "src", "daemon"), { recursive: true });
    await writeFile(path.join(root, "src", "core", "example.ts"), "export const core = 1;\n", "utf8");
    await writeFile(path.join(root, "src", "daemon", "example.ts"), "export const daemon = 1;\n", "utf8");
    await mkdir(path.join(root, "tests"), { recursive: true });
    await writeFile(path.join(root, "tests", "daemon.test.ts"), "import '../src/daemon/example.ts';\n", "utf8");

    const quality = await computeQualityGrades(root);
    const belowA = domainsBelowGrade(quality, "A");

    expect(quality.domains['core']?.grade).toBe("C");
    expect(quality.domains['daemon']?.grade).toBe("A");
    expect(belowA.map((entry) => entry.domain)).toEqual(["core"]);

    const remediation = buildQualityGateRemediation("core", quality.domains['core']!);
    expect(remediation.title).toBe(qualityGateTaskTitle("core"));
    expect(remediation.description).toContain("No tests reference this domain");
  });
});