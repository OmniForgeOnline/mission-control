import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { FileConnectorVault } from "../src/connectors/vault/file.ts";
import { resolveVaultMode } from "../src/connectors/vault/index.ts";

describe("FileConnectorVault", () => {
  let root: string;
  let vault: FileConnectorVault;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-vault-"));
    vault = new FileConnectorVault(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("round-trips a token through get/set/delete", async () => {
    expect(await vault.get("github")).toBeNull();

    await vault.set("github", { accessToken: "ghp_secret", tokenType: "Bearer" });
    expect((await vault.get("github"))?.accessToken).toBe("ghp_secret");

    // A fresh instance over the same root sees persisted state (durability).
    const reopened = new FileConnectorVault(root);
    expect((await reopened.get("github"))?.accessToken).toBe("ghp_secret");

    await vault.delete("github");
    expect(await vault.get("github")).toBeNull();
  });

  it("writes tokens to <root>/data/state/connector-tokens.json at mode 0o600", async () => {
    await vault.set("gitlab", { accessToken: "glpat_secret" });

    const file = path.join(root, "data", "state", "connector-tokens.json");
    const fileStat = await stat(file);
    expect(fileStat.mode & 0o777).toBe(0o600);

    const dirStat = await stat(path.dirname(file));
    expect(dirStat.mode & 0o777).toBe(0o700);
  });

  it("does not mutate the input payload object", async () => {
    const payload = { accessToken: "tok" };
    await vault.set("c", payload);
    payload.accessToken = "mutated";
    expect((await vault.get("c"))?.accessToken).toBe("tok");
  });
});

describe("resolveVaultMode", () => {
  it("prefers an explicit mode over env and platform", () => {
    expect(resolveVaultMode({ explicit: "file", envVault: "keychain", platform: "darwin" })).toBe("file");
  });

  it("honors a valid HARNESS_VAULT value", () => {
    expect(resolveVaultMode({ envVault: "memory", platform: "darwin" })).toBe("memory");
    expect(resolveVaultMode({ envVault: "file", platform: "darwin" })).toBe("file");
  });

  it("ignores an unrecognized HARNESS_VAULT value", () => {
    expect(resolveVaultMode({ envVault: "kms", platform: "linux" })).toBe("file");
  });

  it("defaults to keychain on macOS and file elsewhere", () => {
    expect(resolveVaultMode({ platform: "darwin" })).toBe("keychain");
    expect(resolveVaultMode({ platform: "linux" })).toBe("file");
    expect(resolveVaultMode({ platform: "win32" })).toBe("file");
  });
});
