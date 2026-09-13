import { defineConfig } from "vite";

export default defineConfig({
  // Project pages are served from /<repo>/ on github.io; local dev/preview stays at /.
  base: process.env.VITE_BASE_PATH || "/",
  // Load VITE_* vars from the repo-root .env (single env file for scripts + frontend).
  envDir: "..",
  server: { port: 5173, fs: { allow: ["..", "."] } },
});
