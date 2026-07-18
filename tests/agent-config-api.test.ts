import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { createServer } from "../src/server/app.ts";

describe("agent config API", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-agent-config-api-"));
    await ensureHarnessRepository(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("exposes config and usage in app state", async () => {
    const app = createServer({ root });
    const response = await request(app).get("/api/state");
    expect(response.status).toBe(200);
    expect(response.body.agentConfig.tools.map((t: { id: string }) => t.id).sort()).toEqual([
      "claude",
      "codex",
      "cursor",
      "grok",
      "kiro",
      "opencode"
    ]);
    expect(response.body.agentUsageSnapshots.snapshots).toEqual([]);
  });

  it("performs CRUD on tools and pools", async () => {
    const app = createServer({ root });
    const created = await request(app)
      .put("/api/agent-config/tools")
      .send({ id: "kilo-cli", command: "kilo", adapter: "generic", commandTemplate: ["run", "{prompt}"] });
    expect(created.status).toBe(200);
    expect(created.body.config.tools.some((t: { id: string }) => t.id === "kilo-cli")).toBe(true);

    const pool = await request(app)
      .put("/api/agent-config/pools")
      .send({ id: "kilo-free", toolId: "kilo-cli", tier: "free", capabilities: ["author"], qualityWeight: 70 });
    expect(pool.status).toBe(200);

    const deletedBuiltin = await request(app).delete("/api/agent-config/tools/codex");
    expect(deletedBuiltin.status).toBe(400);

    const deleted = await request(app).delete("/api/agent-config/tools/kilo-cli");
    expect(deleted.status).toBe(200);
    expect(deleted.body.config.pools.some((p: { id: string }) => p.id === "kilo-free")).toBe(false);
  });

  it("rejects an invalid tool payload", async () => {
    const app = createServer({ root });
    const response = await request(app).put("/api/agent-config/tools").send({ id: "bad id", command: "x" });
    expect(response.status).toBe(400);
  });

  it("bulk-enables or disables all pools for a tool", async () => {
    const app = createServer({ root, testMode: true });
    const off = await request(app)
      .post("/api/agent-config/pools/bulk-enabled")
      .send({ toolId: "cursor", enabled: false })
      .expect(200);
    expect(off.body.config.pools.filter((p: { toolId: string }) => p.toolId === "cursor").every((p: { enabled: boolean }) => !p.enabled)).toBe(
      true
    );

    const on = await request(app)
      .post("/api/agent-config/pools/bulk-enabled")
      .send({ toolId: "cursor", enabled: true })
      .expect(200);
    expect(on.body.config.pools.filter((p: { toolId: string }) => p.toolId === "cursor").every((p: { enabled: boolean }) => p.enabled)).toBe(
      true
    );

    await request(app).post("/api/agent-config/pools/bulk-enabled").send({ toolId: "nope", enabled: false }).expect(404);
    await request(app).post("/api/agent-config/pools/bulk-enabled").send({ toolId: "cursor" }).expect(400);
  });

  it("includes runtime diagnostics without blocking config loading", async () => {
    const app = createServer({ root });
    await request(app)
      .put("/api/agent-config/tools")
      .send({ id: "missing-runtime", command: "definitely-not-a-harness-agent", adapter: "generic" })
      .expect(200);
    const response = await request(app).get("/api/agent-config").expect(200);
    const runtime = response.body.runtimeDiagnostics as Record<string, { available: boolean; diagnostics: Array<{ code: string }> }>;
    expect(runtime["missing-runtime"]?.available).toBe(false);
    expect(runtime["missing-runtime"]?.diagnostics[0]?.code).toBe("AGENT_COMMAND_NOT_FOUND");
  });

  it("probes one or all tools and returns updated availability", async () => {
    const app = createServer({ root, testMode: true });
    await request(app)
      .put("/api/agent-config/tools")
      .send({ id: "missing-runtime", command: "definitely-not-a-harness-agent", adapter: "generic" })
      .expect(200);

    const one = await request(app)
      .post("/api/agent-config/probe")
      .send({ toolId: "missing-runtime" })
      .expect(200);
    expect(one.body.runtimeDiagnostics["missing-runtime"]?.available).toBe(false);
    expect(one.body.runtimeDiagnostics["missing-runtime"]?.diagnostics[0]?.code).toBe("AGENT_COMMAND_NOT_FOUND");

    const all = await request(app).post("/api/agent-config/probe").send({}).expect(200);
    expect(all.body.runtimeDiagnostics["missing-runtime"]?.available).toBe(false);
    expect(all.body.runtimeDiagnostics.claude).toBeDefined();

    const missing = await request(app).post("/api/agent-config/probe").send({ toolId: "nope" }).expect(404);
    expect(missing.body.error).toMatch(/Unknown tool/);
  });

  it("refreshes usage snapshots", async () => {
    const app = createServer({ root, testMode: true });
    const response = await request(app).post("/api/agent-config/usage/refresh");
    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.usage.snapshots)).toBe(true);
  });

  it("CRUDs extension registry entries", async () => {
    const app = createServer({ root, testMode: true });
    const created = await request(app)
      .put("/api/agent-config/extensions")
      .send({
        id: "claude:plugin:demo@market",
        toolId: "claude",
        kind: "plugin",
        displayName: "Demo",
        source: "demo@market",
        detectedFrom: "manual",
        defaultEnabled: false
      });
    expect(created.status).toBe(200);
    expect(created.body.registry.extensions.some((entry: { id: string }) => entry.id === "claude:plugin:demo@market")).toBe(
      true
    );

    const listed = await request(app).get("/api/agent-config/extensions");
    expect(listed.status).toBe(200);
    expect(listed.body.registry.extensions.some((entry: { id: string }) => entry.id === "claude:plugin:demo@market")).toBe(
      true
    );

    const deleted = await request(app).delete("/api/agent-config/extensions/claude%3Aplugin%3Ademo%40market");
    expect(deleted.status).toBe(200);
    expect(deleted.body.registry.extensions.some((entry: { id: string }) => entry.id === "claude:plugin:demo@market")).toBe(
      false
    );
  });

  it("installs marketplace plugins with operator confirmation in test mode", async () => {
    const app = createServer({ root, testMode: true });
    const denied = await request(app)
      .post("/api/agent-config/extensions/install")
      .send({ toolId: "claude", source: "demo@market" });
    expect(denied.status).toBe(400);

    const installed = await request(app)
      .post("/api/agent-config/extensions/install")
      .send({ toolId: "claude", source: "demo@market", confirmed: true });
    expect(installed.status).toBe(200);
    expect(installed.body.install.selector).toBe("demo@market");
    expect(
      installed.body.registry.extensions.some((entry: { id: string }) => entry.id === "claude:plugin:demo@market")
    ).toBe(true);
  });
});
