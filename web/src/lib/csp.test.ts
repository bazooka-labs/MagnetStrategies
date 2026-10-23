/**
 * The Content-Security-Policy, asserted against the real config.
 *
 * ── Why this file exists ──
 * The policy is Report-Only, which means every gap in it is INVISIBLE until the
 * day it is enforced, and then it breaks something outright. On 2026-10-23 a
 * real console log found the first one: Pera runs its own WalletConnect relay
 * at `wss://wallet-connect-f.perawallet.app`, the https hosts were listed and
 * the wss ones were not, so enforcing the policy would have broken wallet
 * connection entirely.
 *
 * A comment saying "remember the wss hosts" would not have caught that. These
 * tests encode the hosts the app is KNOWN to need, so the list cannot regress
 * quietly, and so flipping the header to enforcing is a smaller leap.
 *
 * What this canNOT do: prove the list is complete. Pera and Defly resolve their
 * web-wallet iframe hosts from an API at runtime, so they are not enumerable
 * from source at all. Report-Only plus a human using the site is still the only
 * way to finish the list — see the walkthrough in next.config.js.
 */
import { describe, expect, it } from "vitest";

type Header = { key: string; value: string };
type Route = { source: string; headers: Header[] };

async function directives(): Promise<Record<string, string[]>> {
  // Required, not imported: next.config.js is CommonJS and not part of the
  // TypeScript program.
  const { createRequire } = await import("node:module");
  const req = createRequire(import.meta.url);
  const config = req(process.cwd() + "/next.config.js") as
    { headers: () => Promise<Route[]> };
  const routes = await config.headers();
  const header = routes[0].headers.find((h) => h.key.startsWith("Content-Security-Policy"));
  if (!header) throw new Error("no CSP header in next.config.js");
  const out: Record<string, string[]> = {};
  for (const part of header.value.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) out[name] = sources;
  }
  return out;
}

/** Does `sources` permit this URL, by CSP host-source matching? */
function permits(sources: string[], url: string): boolean {
  const u = new URL(url);
  return sources.some((src) => {
    if (!src.includes("://")) return false;
    const s = new URL(src.replace("*.", "wildcard."));
    if (s.protocol !== u.protocol) return false;
    if (src.includes("://*.")) {
      const suffix = src.split("://*.")[1];
      // A wildcard matches a subdomain, not the bare domain.
      return u.hostname.endsWith(`.${suffix}`);
    }
    return s.hostname === u.hostname;
  });
}

describe("connect-src covers the wallet relays", () => {
  it("permits the exact Pera relay from the 2026-10-23 violation", async () => {
    const d = await directives();
    // The URL verbatim from the console. This is the regression test for a
    // real, observed gap — not a hypothetical host.
    expect(permits(d["connect-src"],
      "wss://wallet-connect-f.perawallet.app/?env=browser&protocol=wc&version=1")).toBe(true);
  });

  it("permits both schemes for every wallet domain, not just https", async () => {
    const d = await directives();
    // The shape of the bug: https listed, wss forgotten. Asserted for all
    // three connectors so finding it once fixes it everywhere.
    for (const host of ["perawallet.app", "defly.app", "walletconnect.com", "walletconnect.org"]) {
      expect(permits(d["connect-src"], `https://relay.${host}/`), `https ${host}`).toBe(true);
      expect(permits(d["connect-src"], `wss://relay.${host}/`), `wss ${host}`).toBe(true);
    }
  });

  it("still permits the chain and price endpoints the app actually calls", async () => {
    const d = await directives();
    for (const url of [
      "https://mainnet-api.algonode.cloud/v2/status",
      "https://pub-1e72beea87f04ebfafce248132310425.r2.dev/mainnet/v2/oracle.json",
      "https://api.exchange.coinbase.com/products/ALGO-USD/ticker",
      "https://allo.info/tx/ABC",
    ]) {
      expect(permits(d["connect-src"], url), url).toBe(true);
    }
  });

  it("does not permit an arbitrary third party", async () => {
    const d = await directives();
    expect(permits(d["connect-src"], "https://evil.example.com/")).toBe(false);
    expect(permits(d["connect-src"], "wss://evil.example.com/")).toBe(false);
    // A wildcard must not match the bare domain of someone else's suffix.
    expect(permits(d["connect-src"], "https://notperawallet.app/")).toBe(false);
  });
});

describe("script-src trusts no third party", () => {
  it("lists no remote origin at all", async () => {
    const d = await directives();
    // s3.tradingview.com was here while a srcdoc frame inherited this policy
    // and loaded TradingView's script. The chart now frames their page
    // directly, so nothing of ours fetches a third-party script. If an origin
    // reappears here, something is injecting a remote script into our realm —
    // the realm that signs transactions.
    const remote = d["script-src"].filter((s) => s.includes("://"));
    expect(remote, `unexpected script origin(s): ${remote.join(", ")}`).toEqual([]);
  });
});

describe("frame-src covers the frames the app creates", () => {
  it("permits the TradingView widget host and its fallback", async () => {
    const d = await directives();
    expect(permits(d["frame-src"],
      "https://www.tradingview-widget.com/embed-widget/advanced-chart/")).toBe(true);
    expect(permits(d["frame-src"], "https://s.tradingview.com/embed-widget/")).toBe(true);
  });

  it("does NOT permit www.tradingview.com, which is never framed", async () => {
    const d = await directives();
    // Listed in the widget config as `support_host` only. Allowing it would
    // widen the policy for a frame the app never creates.
    expect(permits(d["frame-src"], "https://www.tradingview.com/")).toBe(false);
  });

  it("permits the Vestige widget on /tokens", async () => {
    const d = await directives();
    expect(permits(d["frame-src"], "https://vestige.fi/chart")).toBe(true);
  });
});

describe("the header is still Report-Only", () => {
  it("has not been flipped to enforcing as a side effect", async () => {
    const { createRequire } = await import("node:module");
    const req = createRequire(import.meta.url);
    const config = req(process.cwd() + "/next.config.js") as { headers: () => Promise<Route[]> };
    const keys = (await config.headers())[0].headers.map((h) => h.key);
    /**
     * Enforcing is the right end state, and next.config.js says to do it as its
     * own deliberate change once the console is clean. This asserts it has not
     * happened by accident inside an unrelated commit — and when it IS done on
     * purpose, this test is the one line to update, which makes the flip
     * visible in the diff.
     */
    expect(keys).toContain("Content-Security-Policy-Report-Only");
    expect(keys).not.toContain("Content-Security-Policy");
  });
});
