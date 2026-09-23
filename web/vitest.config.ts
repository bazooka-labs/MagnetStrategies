import { defineConfig } from "vitest/config";
import path from "node:path";

// Dev-only. Not part of `next build`; adds nothing to the production bundle.
export default defineConfig({
  resolve: { alias: { "@": path.resolve(process.cwd(), "src") } },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
