// Bundles the server and the gbrain MCP server to self-contained ESM JavaScript in
// dist/. Bundling (not per-file transpile) is required because Node disables type
// stripping inside node_modules, so the published package must ship plain JS. Node
// builtins and node_modules packages (express, marked, yaml, ...) stay external.
import { build } from "esbuild";

await build({
  entryPoints: {
    server: "src/server/index.ts",
    "gbrain-server": "src/mcp/gbrain-server.ts"
  },
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node20",
  packages: "external",
  outdir: "dist",
  sourcemap: true,
  logLevel: "info"
});

console.log("Bundled server + gbrain-server -> dist");
