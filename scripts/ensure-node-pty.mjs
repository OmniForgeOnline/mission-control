// node-pty@1.x ships darwin spawn-helper prebuilds as 644 (microsoft/node-pty#850).
// Without +x, pty.spawn fails with "posix_spawnp failed". Run after install.
import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

function fixPackage(root) {
  const prebuilds = path.join(root, "prebuilds");
  if (!existsSync(prebuilds)) return 0;
  let n = 0;
  for (const platform of readdirSync(prebuilds)) {
    const helper = path.join(prebuilds, platform, "spawn-helper");
    if (!existsSync(helper)) continue;
    const mode = statSync(helper).mode;
    if ((mode & 0o111) === 0o111) continue;
    chmodSync(helper, mode | 0o755);
    n += 1;
  }
  return n;
}

let root;
try {
  root = path.resolve(path.dirname(require.resolve("node-pty")), "..");
} catch {
  // Optional during partial installs.
  process.exit(0);
}

const fixed = fixPackage(root);
if (fixed > 0) {
  console.log(`ensure-node-pty: set +x on ${fixed} spawn-helper binary(ies) under ${root}`);
}
