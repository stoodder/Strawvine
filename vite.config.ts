import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/** Identifies this web build: `BUILD_ID` if set (the server honours the same variable), else `<git sha>-<timestamp>`. */
function buildId(): string {
  const env = process.env.BUILD_ID?.trim();
  if (env) return env;
  let sha = process.env.SOURCE_VERSION?.slice(0, 12) ?? "";
  if (!sha) {
    try {
      sha = execSync("git rev-parse --short=12 HEAD", { stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim();
    } catch {
      sha = "nogit";
    }
  }
  return `${sha}-${Date.now().toString(36)}`;
}

const BUILD_ID = buildId();

/**
 * Emits /build.json ({ id, assets }) — the service worker precaches exactly this build's files —
 * and writes the id to <outDir>/../build-id.txt (dist/build-id.txt), where the server reads the
 * id it sends back in `x-strawvine-build`.
 */
function buildManifest(): Plugin {
  return {
    name: "strawvine-build-manifest",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const assets = Object.keys(bundle)
        .filter((f) => f.startsWith("assets/"))
        .sort();
      this.emitFile({ type: "asset", fileName: "build.json", source: JSON.stringify({ id: BUILD_ID, assets }) });
    },
    writeBundle(options) {
      if (!options.dir) return;
      const parent = path.resolve(options.dir, "..");
      mkdirSync(parent, { recursive: true });
      writeFileSync(path.join(parent, "build-id.txt"), `${BUILD_ID}\n`);
    },
  };
}

export default defineConfig({
  root: "src/web",
  publicDir: "public",
  plugins: [react(), tailwindcss(), buildManifest()],
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5173,
    host: true,
    proxy: { "/api": "http://localhost:3000" },
  },
});
