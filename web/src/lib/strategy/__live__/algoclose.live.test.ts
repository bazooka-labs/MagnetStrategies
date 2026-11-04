/**
 * Closing an ALGO-collateral position, end to end against MainNet.
 *
 * Nothing is signed: `signTransactions` throws a sentinel, so reaching it
 * means build, assert and simulate all passed on real bytes.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * It caught a regression I had introduced myself. `closePositionInner` passed
 * the POSITION'S collateral asset to `readYieldRegistry`, whose third argument
 * is actually the asset whose Folks strategy to read — the pool's stable side.
 * The two are the same value for a USDC position, which is why nothing failed
 * for weeks. For ALGO there is no `yc2:` box, so every ALGO close died on a
 * 404 before any assertion could run.
 *
 * Nothing hermetic could have found that: the box either exists on chain or
 * it does not.
 */
import { describe, it, expect } from "vitest";
import algosdk from "algosdk";
import { readPosition, readMarketState, readMarketFunding } from "@/lib/strategy/pex/reads";
import { getOraclePayload } from "@/lib/strategy/pex/oracle";
import { quoteClose } from "@/lib/strategy/pex/quote";
import { closePosition } from "@/lib/strategy/perps/client";
import {
  PEX_APPS, PEX_ASSETS, BUILDER_ADDRESS, POSITION_BUILDER_FEE_BPS,
} from "@/lib/strategy/pex/config";

const algod = new algosdk.Algodv2("", "https://mainnet-api.algonode.cloud", "");
const SENTINEL = "STOP BEFORE SIGNING";

/**
 * Find ANY live ALGO-collateral position on market 1, whoever holds it.
 *
 * It used to name a wallet. That wallet's position is not ours to keep: it
 * can be closed or resized at any moment, and it grew tenfold in a day while
 * this file was being written. A regression test for the ALGO close must not
 * depend on one stranger's trade still being open.
 *
 * Reads the `p2:` key space directly rather than guessing an owner — the key
 * is `p2: ‖ marketId ‖ collateralAssetId ‖ side ‖ owner`, so every
 * ALGO-collateral position on the market is enumerable.
 */
async function anyAlgoPosition(): Promise<{ owner: string; side: 1 | 2 } | null> {
  const { boxes } = await algod.getApplicationBoxes(PEX_APPS.trading).max(1000).do();
  for (const b of boxes) {
    const n = Buffer.from(b.name);
    if (n.length < 59 || n.subarray(0, 3).toString() !== "p2:") continue;
    if (n.readBigUInt64BE(3) !== BigInt(1)) continue;            // market 1
    if (n.readBigUInt64BE(11) !== BigInt(PEX_ASSETS.algo)) continue; // ALGO collateral
    const side = Number(n.readBigUInt64BE(19)) as 1 | 2;
    return { owner: algosdk.encodeAddress(n.subarray(27, 59)), side };
  }
  return null;
}

describe("an ALGO-collateral close", () => {
  it("builds, asserts and simulates on real bytes", async () => {
    const found = await anyAlgoPosition();
    if (!found) {
      throw new Error(
        "No ALGO-collateral position on market 1 to exercise. Open one from "
        + "/trade/admin; this test is vacuous without one.",
      );
    }
    const { owner: HOLDER, side: sideCode } = found;
    const side = sideCode === 1 ? "long" as const : "short" as const;
    const pos = await readPosition(algod, HOLDER, 1, PEX_ASSETS.algo, sideCode);
    if (!pos || pos.size_usd === BigInt(0)) {
      // The one ALGO position on chain belongs to someone else and may be
      // closed at any time. Say so loudly rather than passing vacuously.
      throw new Error(
        "No ALGO-collateral position on market 1 to exercise. This test is "
        + "now vacuous — point HOLDER at a live one or open one from the "
        + "admin page.",
      );
    }
    const [state, funding, oracle] = await Promise.all([
      readMarketState(algod, 1), readMarketFunding(algod, 1),
      getOraclePayload(PEX_APPS.trading, 1),
    ]);
    const quote = quoteClose({
      state, funding, oracle, side, owner: HOLDER,
      position: pos as unknown as Record<string, bigint>,
      sizeUsdMicro: pos.size_usd,
      collateralAssetId: PEX_ASSETS.algo,
      builderAddress: BUILDER_ADDRESS, builderFeeBps: POSITION_BUILDER_FEE_BPS,
      algoPrice12: oracle.indexPrice12,
    });
    expect(quote.ok, `PEX refused the close: ${quote.blockedReason}`).toBe(true);

    /**
     * The payout is valued at the ORACLE price, not counted as dollars.
     *
     * The collateral is ~2108 ALGO against a ~$206 position, so a payout
     * counted rather than priced would read about ten times too large. Pinned
     * as a RATIO against the collateral's own USD value so it survives both
     * the price moving and the holder resizing — this position grew tenfold
     * in a single day while this test was being written.
     */
    const collateralUsd = Number(pos.collateral_amount) / 1e6
      * (Number(oracle.indexPrice12) / 1e12);
    expect(quote.payoutUsd).not.toBeNull();
    expect(quote.payoutUsd! / collateralUsd).toBeGreaterThan(0.5);
    expect(quote.payoutUsd! / collateralUsd).toBeLessThan(2);

    await expect(closePosition({
      algod,
      signTransactions: async () => { throw new Error(SENTINEL); },
      sender: HOLDER, marketId: 1, side,
      collateralAssetId: PEX_ASSETS.algo,
      sizeUsdMicro: pos.size_usd, position: pos, quote, slippageBps: 100,
    })).rejects.toThrow(SENTINEL);
  });
});
