import { rm } from "node:fs/promises";

/**
 * Best-effort background writes (memory capture, run artifacts) can still be
 * flushing when the test tears down. macOS recursive rm is non-atomic, so a
 * file landing mid-removal throws ENOTEMPTY. Retry briefly until it drains.
 */
export async function rmRoot(dir: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if ((code === "ENOTEMPTY" || code === "EBUSY") && attempt < 10) {
        await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
}
