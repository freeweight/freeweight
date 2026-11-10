import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { docs } from "./scripts/vite-docs";

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

// Dev proxy: set FW_API (for example in .env.local) to the staging gateway origin to test against the live API.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, here("."), "");
  const target = env.FW_API;
  const proxy = target
    ? Object.fromEntries(
        ["/api", "/v1", "/mcp"].map((p) => [p, { target, changeOrigin: true, secure: true, cookieDomainRewrite: "" }]),
      )
    : undefined;
  // Link previews want an absolute image address. FW_SITE is the public origin, when the build is for a known one.
  const site = (env.FW_SITE ?? "").replace(/\/+$/, "");
  const social: Plugin = {
    name: "fw-social",
    transformIndexHtml: (html) => (site ? html.replaceAll('content="/og.png"', `content="${site}/og.png"`) : html),
  };
  return {
    plugins: [
      react(),
      social,
      docs({
        site: here("../../docs/site"),
        fixtures: here("./src/docs"),
        publish: {
          "llms.txt": here("../../docs/site/llms.txt"),
          "openapi.yaml": here("../../docs/api/openapi.yaml"),
        },
      }),
    ],
    // Always a literal, so a build without the flag drops the mock gateway and the demo wallet as dead code.
    define: { "import.meta.env.VITE_MOCK": JSON.stringify(env.VITE_MOCK === "1" ? "1" : "") },
    // The docs pages live at the repo root, outside this app.
    server: { host: "127.0.0.1", port: 5173, proxy, fs: { allow: [here("../..")] } },
    preview: { host: "127.0.0.1", port: 4173 },
    build: {
      target: "es2022",
      sourcemap: false,
      assetsInlineLimit: 0,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes("node_modules/react") || id.includes("node_modules/scheduler")) return "react";
            return undefined;
          },
        },
      },
    },
  };
});
