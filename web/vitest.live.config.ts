import { defineConfig } from "vitest/config";
import path from "path";

// Live MainNet checks, excluded from `npm test` by the `.live.test.ts` suffix.
export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  test: { include: ["src/**/*.live.test.ts"], testTimeout: 90_000 },
});
