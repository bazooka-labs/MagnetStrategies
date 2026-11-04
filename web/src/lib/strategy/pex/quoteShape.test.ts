/**
 * The SDK's collateral-denominated fields, in the OPEN quote.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * Review mutated these conversions and nothing noticed: replacing every
 * `colUsd` with `toUsd`, and multiplying `netCollateralUsd` by ten, both left
 * the whole suite green. Six fields the commit message said were fixed had
 * nothing holding them in place.
 *
 * ── The property, which needs no model ──────────────────────────────────────
 * The SDK returns these as `tokenAmountFromUsd(..., collateralPrice)`, so
 * they are COLLATERAL TOKEN units. Converting them correctly means the SAME
 * trade — same side, same notional, same dollar value of collateral — reports
 * the same costs in dollars whether it is backed by ALGO or by USDC.
 *
 * That is a statement about PEX's own quoter, compared against itself. No
 * closed form, no second opinion about fees. If a field is left unconverted,
 * the ALGO figure is wrong by the ALGO price — about tenfold — and the two
 * stop agreeing.
 */
import { describe, expect, it } from "vitest";
import snapshot from "@/lib/strategy/__fixtures__/marketSnapshot.json";
import { quoteOpen } from "@/lib/strategy/pex/quote";
import { assetPrice12 } from "@/lib/strategy/pex/oracle";
import { BUILDER_ADDRESS, DEFAULT_SLIPPAGE_BPS, PEX_ASSETS } from "@/lib/strategy/pex/config";
import type { MarketState } from "@/lib/strategy/pex/reads";
import type { OraclePayload } from "@/lib/strategy/pex/oracle";

function revive<T>(v: unknown): T {
  if (Array.isArray(v)) return v.map(revive) as unknown as T;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.__big === "string") return BigInt(o.__big) as unknown as T;
    if (typeof o.__bytes === "string") {
      return new Uint8Array(Buffer.from(o.__bytes, "base64")) as unknown as T;
    }
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(o)) out[k] = revive(val);
    return out as T;
  }
  return v as T;
}

const snap = revive<{ state: MarketState; oracle: OraclePayload }>(snapshot);
const algoPrice12 = assetPrice12(snap.oracle.decoded, PEX_ASSETS.algo)!;

/** $40 of collateral, posted in each asset, against the same notional. */
const USD_MICRO = BigInt(40_000_000);
const ALGO_MICRO = (USD_MICRO * BigInt(1_000_000_000_000)) / algoPrice12;
const NOTIONAL = 120;

const quote = (collateralAssetId: number, collateralAmountMicro: bigint) => quoteOpen({
  state: snap.state, oracle: snap.oracle, side: "long",
  collateralAmountMicro, notionalUsd: NOTIONAL,
  builderAddress: BUILDER_ADDRESS, collateralAssetId,
  algoPrice12, slippageBps: DEFAULT_SLIPPAGE_BPS,
});

describe("the same trade costs the same in dollars, whichever asset backs it", () => {
  const usdc = quote(PEX_ASSETS.usdc, USD_MICRO);
  const algo = quote(PEX_ASSETS.algo, ALGO_MICRO);

  it("quotes both successfully, so the comparison means something", () => {
    expect(usdc.ok, `USDC: ${usdc.reasons.join()}`).toBe(true);
    expect(algo.ok, `ALGO: ${algo.reasons.join()}`).toBe(true);
  });

  /**
   * 2% covers the ~4bp price bands, the floor in the ALGO conversion, and the
   * fact that the two quotes post amounts that are equal in dollars but not
   * identical to the micro-unit. It does NOT cover a missing conversion,
   * which is wrong by about a factor of ten.
   */
  const agree = (a: number, b: number, what: string) => {
    const diff = Math.abs(a - b) / Math.max(Math.abs(b), 1e-9);
    expect(diff, `${what}: ALGO ${a} vs USDC ${b}`).toBeLessThan(0.02);
  };

  it("agrees on the open fee", () => {
    agree(algo.openFeeUsd, usdc.openFeeUsd, "openFeeUsd");
  });

  it("agrees on the builder fee", () => {
    agree(algo.builderFeeUsd, usdc.builderFeeUsd, "builderFeeUsd");
  });

  it("agrees on what backs the position", () => {
    // The figure the card headlines as "Backing the position".
    agree(algo.netCollateralUsd, usdc.netCollateralUsd, "netCollateralUsd");
  });

  it("agrees on leverage, which is every conversion compounded", () => {
    agree(algo.leverage, usdc.leverage, "leverage");
  });

  it("reports the ALGO collateral near its dollar value, not its unit count", () => {
    // The blunt version: ~403 ALGO backing a $40 position must not read as
    // $403. This is the shape of every conversion failure in this file.
    expect(algo.netCollateralUsd).toBeGreaterThan(30);
    expect(algo.netCollateralUsd).toBeLessThan(50);
  });
});
