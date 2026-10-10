import { defineConfig } from "vitest/config";
import path from "node:path";

// Dev-only. Not part of `next build`; adds nothing to the production bundle.
//
// ── Two environments on purpose ───────────────────────────────────────────
// `.test.ts` stays on `node`: those are library tests, they are fast, and
// nothing about them wants a DOM.
//
// `.test.tsx` runs in jsdom so components can actually be MOUNTED. Audit 11's
// structural finding was that none of them could be — the glob was `.test.ts`
// only, there was no jsdom, and so every guard on a 1,950-line money-path
// component was pinned by a string match. Three of those tests passed under
// the bugs they claimed to prevent.
//
// The environment is chosen per file by the `@vitest-environment` docblock at
// the top of each `.test.tsx`, rather than by a glob here, so a file states its
// own requirement and cannot silently get the wrong one after a config edit.
export default defineConfig({
  // JSX via esbuild's automatic runtime rather than @vitejs/plugin-react: the
  // plugin is ESM-only and this config is loaded as CJS. One less dependency.
  esbuild: { jsx: "automatic" },
  resolve: { alias: { "@": path.resolve(process.cwd(), "src") } },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: ["./vitest.setup.ts"],
  },
});
