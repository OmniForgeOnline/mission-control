import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createServer } from "../src/server/app.ts";
import { startListening } from "../src/server/listen.ts";
import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";

describe("startListening", () => {
  let root: string;
  // Track every bound server so afterEach can close them and avoid leaking
  // handles (which would hang the vitest process between files).
  const bound: Server[] = [];

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-listen-"));
    await ensureHarnessRepository(root);
  });

  afterEach(async () => {
    await Promise.all(
      bound.map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve()))
      )
    );
    bound.length = 0;
    await rm(root, { recursive: true, force: true });
  });

  it("resolves only once the socket is actually bound and serving", async () => {
    const server = await startListening(createServer({ root, testMode: true }), 0, "127.0.0.1");
    bound.push(server);

    // The promise must not have resolved before the bind completed.
    expect(server.listening).toBe(true);
    const address = server.address() as AddressInfo;
    expect(typeof address.port).toBe("number");
    expect(address.port).toBeGreaterThan(0);
  });

  it("rejects when the port is already in use, so a second startup never reaches writeServerInfo", async () => {
    // First server owns the port.
    const first = await startListening(createServer({ root, testMode: true }), 0, "127.0.0.1");
    bound.push(first);
    const takenPort = (first.address() as AddressInfo).port;

    // A second startup against the same host:port must fail the bind. Because
    // startListening rejects here, index.ts aborts before writeServerInfo, so
    // the live first server's server.json can never be overwritten with a
    // soon-to-be-dead pid that would strand it beyond `mission-control stop`.
    await expect(
      startListening(createServer({ root, testMode: true }), takenPort, "127.0.0.1")
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
  });
});
