import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { gatherProjectIntel } from "../src/core/projects/intel.ts";

describe("gatherProjectIntel", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-intel-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it("detects Python tooling from pyproject.toml [tool.*] sections", async () => {
    await writeFile(
      path.join(root, "pyproject.toml"),
      [
        "[project]",
        'name = "svc"',
        "",
        "[tool.pytest.ini_options]",
        "testpaths = [\"tests\"]",
        "",
        "[tool.ruff]",
        "line-length = 100",
        "",
        "[tool.mypy]",
        "strict = true"
      ].join("\n"),
      "utf8"
    );

    const intel = await gatherProjectIntel(root);
    expect(intel.markers.map((m) => m.path)).toContain("pyproject.toml");
    expect(intel.markers.find((m) => m.path === "pyproject.toml")?.stack).toBe("python");

    const cmds = intel.commands.map((c) => c.command);
    expect(cmds).toContain("pytest");
    expect(cmds).toContain("ruff check .");
    expect(cmds).toContain("mypy .");

    const pytest = intel.commands.find((c) => c.command === "pytest");
    expect(pytest?.category).toBe("test");
    expect(pytest?.source).toContain("pyproject.toml [tool.pytest]");
  });

  it("prefixes Python commands with the declared runner (uv.lock -> uv run)", async () => {
    await writeFile(
      path.join(root, "pyproject.toml"),
      "[tool.pytest.ini_options]\ntestpaths = [\"tests\"]\n",
      "utf8"
    );
    await writeFile(path.join(root, "uv.lock"), "", "utf8");

    const intel = await gatherProjectIntel(root);
    expect(intel.commands.map((c) => c.command)).toContain("uv run pytest");
    expect(intel.markers.map((m) => m.path)).toContain("uv.lock");
  });

  it("detects package.json scripts with the lockfile-selected package manager", async () => {
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { lint: "eslint .", test: "vitest run", typecheck: "tsc --noEmit" } }),
      "utf8"
    );
    await writeFile(path.join(root, "package-lock.json"), "{}", "utf8");

    const intel = await gatherProjectIntel(root);
    const cmds = intel.commands.map((c) => c.command);
    expect(cmds).toContain("npm run -s lint");
    expect(cmds).toContain("npm run -s test");
    expect(cmds).toContain("npm run -s typecheck");
    expect(intel.commands.find((c) => c.command === "npm run -s lint")?.source).toContain("package.json");
  });

  it("uses yarn when yarn.lock is present", async () => {
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { lint: "eslint ." } }),
      "utf8"
    );
    await writeFile(path.join(root, "yarn.lock"), "", "utf8");

    const intel = await gatherProjectIntel(root);
    expect(intel.commands.map((c) => c.command)).toContain("yarn run lint");
  });

  it("detects canonical Makefile targets", async () => {
    await writeFile(path.join(root, "Makefile"), "lint:\n\truff check .\n\ntest:\n\tpytest\n\nhelp:\n\t@echo hi\n", "utf8");

    const intel = await gatherProjectIntel(root);
    const cmds = intel.commands.map((c) => c.command);
    expect(cmds).toContain("make lint");
    expect(cmds).toContain("make test");
    // Non-canonical targets (help) are not promoted to gate commands.
    expect(cmds).not.toContain("make help");
    expect(intel.commands.find((c) => c.command === "make test")?.source).toContain("Makefile target `test`");
  });

  it("collects build/test/lint commands mentioned in docs", async () => {
    await writeFile(
      path.join(root, "README.md"),
      ["# Project", "", "Run tests:", "", "```", "npm test", "```", "", "Build with `npm run build`."].join("\n"),
      "utf8"
    );

    const intel = await gatherProjectIntel(root);
    const readme = intel.docs.find((d) => d.path === "README.md");
    expect(readme).toBeTruthy();
    const all = readme!.commands.join(" ");
    expect(all).toContain("npm test");
    expect(all).toContain("npm run build");
  });

  it("collects root-level DEVELOPMENT.md and DEVELOPING.md as contributor docs", async () => {
    // The DOC_GLOB filename allowlist must match the develop family beyond the bare
    // `develop` token: DEVELOPMENT.md / DEVELOPING.md are common homes for the build,
    // test, and lint instructions the synthesis fallback relies on. A trailing \b on
    // the `develop` alternation silently drops them, degrading the gate to incomplete
    // for a repo that genuinely documents its commands.
    await writeFile(
      path.join(root, "DEVELOPMENT.md"),
      ["## Developing", "", "```", "npm test", "npm run lint", "```"].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(root, "DEVELOPING.md"),
      "Build with `npm run build`.\n",
      "utf8"
    );

    const intel = await gatherProjectIntel(root);
    const paths = intel.docs.map((d) => d.path);
    expect(paths).toContain("DEVELOPMENT.md");
    expect(paths).toContain("DEVELOPING.md");

    const dev = intel.docs.find((d) => d.path === "DEVELOPMENT.md");
    expect(dev).toBeTruthy();
    expect(dev!.commands.join(" ")).toContain("npm test");
  });

  it("collects build/test/lint commands from docs/ and .github/ subdirectories", async () => {
    await mkdir(path.join(root, "docs"), { recursive: true });
    await mkdir(path.join(root, ".github"), { recursive: true });
    await writeFile(
      path.join(root, "docs", "development.md"),
      ["## Developing", "", "```", "npm test", "npm run lint", "```"].join("\n"),
      "utf8"
    );
    // A docs file named after a build concept, not in the root DOC_GLOB allowlist,
    // must still be found because the docs/ directory signals documentation.
    await writeFile(path.join(root, "docs", "build.md"), "Build with `npm run build`.\n", "utf8");
    await writeFile(
      path.join(root, ".github", "CONTRIBUTING.md"),
      "Run `npm run typecheck` before pushing.\n",
      "utf8"
    );

    const intel = await gatherProjectIntel(root);
    const paths = intel.docs.map((d) => d.path);
    expect(paths).toContain("docs/development.md");
    expect(paths).toContain("docs/build.md");
    expect(paths).toContain(".github/CONTRIBUTING.md");

    const dev = intel.docs.find((d) => d.path === "docs/development.md");
    expect(dev).toBeTruthy();
    expect(dev!.commands.join(" ")).toContain("npm test");
    expect(dev!.commands.join(" ")).toContain("npm run lint");
  });

  it("ignores non-doc files and build output while scanning doc directories", async () => {
    await mkdir(path.join(root, "docs", "node_modules", "some-pkg"), { recursive: true });
    await mkdir(path.join(root, ".github", "workflows"), { recursive: true });
    // Build output and CI yaml are not documentation and must be skipped.
    await writeFile(path.join(root, "docs", "node_modules", "some-pkg", "readme.md"), "lint: eslint .\n", "utf8");
    await writeFile(path.join(root, ".github", "workflows", "ci.yml"), "- run: pytest\n", "utf8");

    const intel = await gatherProjectIntel(root);
    expect(intel.docs).toEqual([]);
    // CI yaml is still harvested by the dedicated CI scan, not the docs scan.
    expect(intel.ci.map((c) => c.command)).toContain("pytest");
  });

  it("collects run: steps from CI workflows", async () => {
    await mkdir(path.join(root, ".github", "workflows"), { recursive: true });
    await writeFile(
      path.join(root, ".github", "workflows", "ci.yml"),
      ["jobs:", "  build:", "    steps:", "      - run: pytest", "      - run: ruff check ."].join("\n"),
      "utf8"
    );

    const intel = await gatherProjectIntel(root);
    const cmds = intel.ci.map((c) => c.command);
    expect(cmds).toContain("pytest");
    expect(cmds).toContain("ruff check .");
    expect(intel.ci.find((c) => c.command === "pytest")?.source).toContain("CI");
  });

  it("collects commands from multi-line run: | block-scalar steps", async () => {
    // The dominant real-world CI shape indents the shell under `run: |`. Those
    // indented lines never contain `run:`, so the block body must be parsed as a
    // sequence of candidate commands rather than skipped as non-`run:` lines.
    await mkdir(path.join(root, ".github", "workflows"), { recursive: true });
    await writeFile(
      path.join(root, ".github", "workflows", "ci.yml"),
      [
        "jobs:",
        "  build:",
        "    steps:",
        "      - run: |",
        "          npm ci",
        "          npm test"
      ].join("\n"),
      "utf8"
    );

    const intel = await gatherProjectIntel(root);
    const cmds = intel.ci.map((c) => c.command);
    expect(cmds).toContain("npm ci");
    expect(cmds).toContain("npm test");
  });

  it("terminates a run: | block at the first dedent and keeps later steps", async () => {
    // A block must end where indentation returns to the run: key column, so a
    // following step is collected on its own (not swallowed as block body) and a
    // blank line inside the block does not end it prematurely. The folded `>`
    // indicator opens a block too.
    await mkdir(path.join(root, ".github", "workflows"), { recursive: true });
    await writeFile(
      path.join(root, ".github", "workflows", "ci.yml"),
      [
        "jobs:",
        "  build:",
        "    steps:",
        "      - run: |",
        "          npm ci",
        "",
        "      - run: ruff check .",
        "      - run: >",
        "          npm run build"
      ].join("\n"),
      "utf8"
    );

    const intel = await gatherProjectIntel(root);
    const cmds = intel.ci.map((c) => c.command);
    // Block body (blank line tolerated) and the folded `>` body are harvested...
    expect(cmds).toContain("npm ci");
    expect(cmds).toContain("npm run build");
    // ...and the inline step after the block is collected separately.
    expect(cmds).toContain("ruff check .");
  });

  it("merges evidence from a mixed repo without duplication or crashing", async () => {
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { lint: "eslint .", test: "vitest run" } }),
      "utf8"
    );
    await writeFile(path.join(root, "Makefile"), "typecheck:\n\ttsc --noEmit\n", "utf8");
    await writeFile(
      path.join(root, "pyproject.toml"),
      "[tool.ruff]\nline-length = 100\n",
      "utf8"
    );

    const intel = await gatherProjectIntel(root);
    const cmds = intel.commands.map((c) => c.command);
    // Each stack contributes; nothing is dropped because another stack exists.
    expect(cmds).toContain("npm run -s lint");
    expect(cmds).toContain("make typecheck");
    expect(cmds).toContain("ruff check .");
    // Dedupe keeps one entry per category+command.
    const lintCount = intel.commands.filter((c) => c.category === "lint").length;
    expect(lintCount).toBe(2); // eslint (node) + ruff (python) are distinct commands
  });

  it("produces no evidence (empty intel) for an unrecognized repo — no generic fallback", async () => {
    const intel = await gatherProjectIntel(root);
    expect(intel.markers).toEqual([]);
    expect(intel.commands).toEqual([]);
    expect(intel.docs).toEqual([]);
    expect(intel.ci).toEqual([]);
    expect(intel.summary).toEqual([]);
  });

  it("surfaces detected build-config files generically (nx workspace + maven)", async () => {
    // nx workspace: nx.json + per-project project.json, plus a maven pom alongside.
    await writeFile(path.join(root, "package.json"), "{}");
    await writeFile(path.join(root, "nx.json"), "{}");
    await mkdir(path.join(root, "apps", "reactapp"), { recursive: true });
    await writeFile(path.join(root, "apps", "reactapp", "project.json"), "{}");
    await writeFile(path.join(root, "pom.xml"), "<project/>");

    const intel = await gatherProjectIntel(root);
    expect(intel.buildConfigs).toContain("nx.json");
    expect(intel.buildConfigs).toContain("package.json");
    expect(intel.buildConfigs).toContain("apps/reactapp/project.json");
    expect(intel.buildConfigs).toContain("pom.xml");
  });
});
