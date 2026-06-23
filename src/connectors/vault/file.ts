import { chmod } from "node:fs/promises";
import path from "node:path";

import type { ConnectorTokenPayload } from "../../core/types.ts";
import { ensureDir, readJsonFile, writeJsonFile } from "../../core/infra/fs.ts";
import type { ConnectorVault } from "./types.ts";

/**
 * File mode bits for the token store and its parent directory. Owner-only so a
 * stored access token is not world-readable on multi-user machines.
 */
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/** Relative to the harness root, alongside the other generated state. */
const TOKENS_RELATIVE = path.join("data", "state", "connector-tokens.json");

type TokenMap = Record<string, ConnectorTokenPayload>;

/**
 * Durable, cross-platform connector token store. Used as the default backend
 * anywhere the OS keychain is unavailable (Linux, Windows). Tokens are kept in a
 * single JSON map under `<root>/data/state/connector-tokens.json`, written
 * atomically and locked to mode 0o600.
 */
export class FileConnectorVault implements ConnectorVault {
  private readonly filePath: string;

  constructor(root: string) {
    this.filePath = path.join(root, TOKENS_RELATIVE);
  }

  async get(connectionId: string): Promise<ConnectorTokenPayload | null> {
    const tokens = await this.read();
    const token = tokens[connectionId];
    return token ?? null;
  }

  async set(connectionId: string, token: ConnectorTokenPayload): Promise<void> {
    await this.write((tokens) => {
      tokens[connectionId] = { ...token };
    });
  }

  async delete(connectionId: string): Promise<void> {
    await this.write((tokens) => {
      delete tokens[connectionId];
    });
  }

  private async read(): Promise<TokenMap> {
    return readJsonFile<TokenMap>(this.filePath, {});
  }

  private async write(mutate: (tokens: TokenMap) => void): Promise<void> {
    const tokens = await this.read();
    mutate(tokens);
    await writeJsonFile(this.filePath, tokens);
    await this.restrict();
  }

  /**
   * Best-effort permission tightening after every write. chmod is a no-op or
   * unsupported on some filesystems (e.g. Windows ACLs); the write already
   * succeeded, so a failure here must not break the store.
   */
  private async restrict(): Promise<void> {
    try {
      const dir = path.dirname(this.filePath);
      await ensureDir(dir);
      await chmod(dir, DIR_MODE);
      await chmod(this.filePath, FILE_MODE);
    } catch {
      /* best-effort; filesystem may not support POSIX modes */
    }
  }
}
