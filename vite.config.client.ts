import preact from "@preact/preset-vite";
import { defineConfig } from "vite";
import path from "node:path";

export default defineConfig({
  plugins: [preact()],
  root: "src/ui",
  resolve: {
    alias: {
      "@harness/core": path.resolve(__dirname, "src/core"),
      "@ui/app": path.resolve(__dirname, "src/ui/app"),
      "@ui/data": path.resolve(__dirname, "src/ui/data"),
      "@ui/shell": path.resolve(__dirname, "src/ui/shell"),
      "@ui/features": path.resolve(__dirname, "src/ui/features"),
      "@ui/shared": path.resolve(__dirname, "src/ui/shared"),
      "@ui/overlays": path.resolve(__dirname, "src/ui/overlays")
    }
  },
  build: {
    outDir: path.resolve(__dirname, "dist/ui"),
    emptyOutDir: true,
    rollupOptions: {
      onwarn(warning, defaultHandler) {
        if (warning.code === "ILLEGAL_REASSIGNMENT") {
          throw new Error(warning.message);
        }
        defaultHandler(warning);
      }
    }
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:4827"
    }
  }
});
