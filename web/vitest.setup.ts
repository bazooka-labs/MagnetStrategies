export {};   // makes this a module, so the top-level awaits below are legal

// Loaded for every test file. Guarded so the node-environment tests, which have
// no DOM, are unaffected.
//
// Testing Library's automatic cleanup only self-registers when the test
// framework exposes a global `afterEach`, and vitest globals are off here — so
// without this, DOM from one test leaks into the next and queries start finding
// two of everything.
if (typeof window !== "undefined") {
  const { afterEach } = await import("vitest");
  const { cleanup } = await import("@testing-library/react");
  await import("@testing-library/jest-dom/vitest");
  afterEach(() => cleanup());
}
