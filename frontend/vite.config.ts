import { defineConfig } from "vite";

export default defineConfig({
  // Load VITE_* vars from the repo-root .env (single env file for scripts + frontend).
  envDir: "..",
  server: { port: 5173, fs: { allow: ["..", "."] } },
});
