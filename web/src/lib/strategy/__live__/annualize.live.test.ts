/**
 * The annualized headline, against the REAL bundle and the REAL vault.
 *
 * ── Why this needs a live test ──
 * The headline is now derived from two sources that must agree on units: the
 * bundle's `share_price_usd` (micro-dollars, snake_case, inside `points[]`)
 * and the contract's `total_nav_usd / total_cva_shares` globals. A parse that
 * silently returns null for either one does not throw and does not blank the
 * card — it quietly falls back to the staler figure, or to no figure at all.
 *
 * That exact class of failure already shipped once in this module's
 * neighbourhood: `costBasis` found zero deposits on an account with two,
 * because the SDK returns `applicationArgs` where the REST shape says
 * `application-args`. Hermetic fixtures agreed with the bug. Only a run
 * against real data caught it, so the anchor's parse is asserted here.
 */
import { describe, expect, it } from "vitest";
import algosdk from "algosdk";
import { fetchPerformanceBundle, cvaKey, pickLongest, MIN_ANNUALIZE_DAYS } from "../pools/performance";
import { PEX_APPS } from "../pex/config";
import { ALGOD_URLS } from "@/lib/constants";

const algod = new algosdk.Algodv2("", ALGOD_URLS.mainnet, "");

/** The vault's live share price, the way `reads.ts` computes it. */
async function liveSharePrice(): Promise<number> {
  const app = await algod.getApplicationByID(PEX_APPS.cvaVault).do();
  let nav: number | null = null, shares: number | null = null;
  for (const kv of app.params.globalState ?? []) {
    const k = Buffer.from(kv.key as unknown as Uint8Array).toString("utf8");
    if (k === "total_nav_usd") nav = Number(kv.value?.uint ?? 0);
    if (k === "total_cva_shares") shares = Number(kv.value?.uint ?? 0);
  }
  expect(nav, "total_nav_usd must exist").not.toBeNull();
  expect(shares, "total_cva_shares must exist").not.toBeNull();
  return nav! / 1e6 / (shares! / 1e6);
}

describe("the headline against live data", () => {
  it("parses a start anchor out of the real bundle", async () => {
    const bundle = await fetchPerformanceBundle();
    const stats = bundle.byKey[cvaKey(PEX_APPS.cvaVault)];
    expect(stats, "the bundle must carry the vault's payload").toBeTruthy();

    const longest = Object.values(stats!.returns)
      .filter((w) => w)
      .sort((a, b) => b!.days - a!.days)[0]!;

    // The parse that would fail silently. A share price near $1 means the
    // 1e6 divisor is right; a raw 1_032_995 would sail past a null check.
    expect(longest.startSharePrice).toBeGreaterThan(0.01);
    expect(longest.startSharePrice).toBeLessThan(100);
    expect(longest.startTs).toBeGreaterThan(1_700_000_000);
    expect(longest.days).toBeGreaterThanOrEqual(MIN_ANNUALIZE_DAYS);
  });

  it("extends the real window to the live price without shortening it", async () => {
    const [bundle, sharePrice] = await Promise.all([
      fetchPerformanceBundle(), liveSharePrice(),
    ]);
    const stats = bundle.byKey[cvaKey(PEX_APPS.cvaVault)]!;

    const bundleOnly = pickLongest(stats, null)!;
    const extended = pickLongest(stats, sharePrice)!;

    // The window grows. On 2026-10-28 this was 55.0d -> 57.0d, because the
    // bundle's `as_of` was 23.8 HOURS old — the staleness this exists to fix.
    expect(extended.days).toBeGreaterThanOrEqual(bundleOnly.days);
    expect(extended.days).toBeGreaterThanOrEqual(MIN_ANNUALIZE_DAYS);

    // And the figure stays in the same neighbourhood: extending the end point
    // by a day or two must not swing the answer, which is the whole reason the
    // window is long. 184% vs 177% when measured.
    const drift = Math.abs(extended.annualizedPct - bundleOnly.annualizedPct);
    expect(drift).toBeLessThan(Math.abs(bundleOnly.annualizedPct) * 0.5 + 25);

    console.log(
      `  bundle-only : ${bundleOnly.realisedPct.toFixed(2)}% / ` +
      `${bundleOnly.days.toFixed(1)}d -> ${bundleOnly.annualizedPct.toFixed(0)}%\n` +
      `  bundle+live : ${extended.realisedPct.toFixed(2)}% / ` +
      `${extended.days.toFixed(1)}d -> ${extended.annualizedPct.toFixed(0)}%  (share price $${sharePrice.toFixed(6)})`,
    );
  });
});
