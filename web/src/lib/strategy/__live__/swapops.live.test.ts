/**
 * Can a withdrawal be returned entirely in USDC, via PEX, for every destination?
 *
 * **Yes — but not always in one transaction.** This corrects an earlier
 * conclusion that single-asset payout existed only on market 1. It exists
 * everywhere; what is restricted to market 1 is doing it *atomically*.
 *
 * ── Two different PEX facilities ──
 *
 *   `AdminOps.withdraw_liquidity_with_swap`  one call, one signature.
 *       Market 1 only — market 2 refuses every mode, and the C-Vault has no
 *       swap method at all (20 methods, none). See swapmode.live.test.ts.
 *
 *   `SwapOps.swap_exact_in`                  a standalone swap.
 *       Works on BOTH markets. A swap is market-scoped, not destination-scoped,
 *       so ALGO from ANY source — market 2's pool, the C-Vault — can be
 *       converted. Its oracle payload must target **SwapOps (3690309163)**;
 *       targeting AdminOps is refused.
 *
 * ── Why it cannot always be one group ──
 * Algorand caps a transaction group at 16.
 *
 *     pool withdraw (10) + swap via m2, no recall (4)  = 14   fits
 *     pool withdraw (10) + swap via m1, with recall (7) = 17   too big
 *     C-Vault withdraw (15) + swap (4)                  = 19   too big
 *
 * So the C-Vault needs a SECOND transaction, which is a second signature and a
 * window in which the user holds both assets and the swap has not happened.
 * That is very likely what Mallow does.
 *
 * Market 2's swap is 4 transactions only because its pool currently holds idle
 * USDC and needs no yield recall. Market 1's needs the recall and is 7. Neither
 * is a fixed property — idle balances move — so a group sized on "4" must be
 * built and simulated per attempt, never assumed.
 */
import { describe, it, expect } from "vitest";
import algosdk from "algosdk";
import { buildV2SwapExactInTransactions, decodeReceipt } from "@pdex/sdk";
import { simulateGroup } from "../../perpsGroup";
import { readQuoteContext, readRecallContext } from "../quote";
import { getOraclePayload } from "../../perpsOracle";
import { PEX_APPS, PEX_ASSETS } from "../../perps";

const algod = new algosdk.Algodv2("", "https://mainnet-api.algonode.cloud", "");
const WALLET = "ALUYA2D55QDUUIY3JORBOB2B7WRTVV477R6URF4P6NY4ZZWB3LUK3DU6WE";
export const MAX_GROUP_SIZE = 16;

async function swap(marketId: number, opts: { recall: 0 | 1; target?: number }) {
  const ctx = await readQuoteContext(algod, marketId);
  const rc = await readRecallContext(algod, ctx);
  const sp = await algod.getTransactionParams().do();
  sp.fee = sp.minFee; sp.flatFee = true;
  const oracle = await getOraclePayload(opts.target ?? PEX_APPS.swapOps, marketId);
  const g = buildV2SwapExactInTransactions({
    sender: WALLET, marketId,
    tokenInAssetId: PEX_ASSETS.algo,
    amountIn: BigInt(2_000_000), minAmountOut: 0,
    yieldRecallMode: opts.recall,
    maxOutputReceiptAmount: BigInt(2_000_000_000),
    marketYieldRegistry: rc.registry,
    oracleMessage: oracle.message, oracleSignature: oracle.signature,
    indexAssetId: marketId === 2 ? PEX_ASSETS.btcIndex : PEX_ASSETS.algo,
    longAssetId: PEX_ASSETS.algo, shortAssetId: PEX_ASSETS.usdc,
    v2MathAppId: PEX_APPS.math, v2MarketsAppId: PEX_APPS.markets,
    v2TradingAppId: PEX_APPS.trading, v2TradingRiskOpsAppId: PEX_APPS.tradingRiskOps,
    v2OrderOpsAppId: PEX_APPS.orderOps, v2AdminOpsAppId: PEX_APPS.adminOps,
    v2SwapOpsAppId: PEX_APPS.swapOps, v2AdminControlAppId: PEX_APPS.adminControl,
    v2MarketYieldVaultAppId: PEX_APPS.marketYieldVault,
    v2MarketXalgoYieldVaultAppId: PEX_APPS.marketXAlgoYieldVault,
  } as never, sp) as algosdk.Transaction[];
  const r = await simulateGroup(algod, g);
  let receipt: Record<string, unknown> | undefined;
  for (const log of r.logs ?? []) {
    if (Buffer.from(log.slice(0, 4)).toString("hex") !== "151f7c75") continue;
    const b = log.slice(4); const len = (b[0] << 8) | b[1];
    try {
      const rec = decodeReceipt(b.slice(2, 2 + len)) as unknown as
        { eventType?: string; fields?: Record<string, unknown> };
      if (rec.eventType === "v2_swap_executed") receipt = rec.fields;
    } catch { /* not a receipt */ }
  }
  return { ok: r.ok, why: r.message, txns: g.length, receipt };
}

describe("live: PEX's standalone swap can take ALGO to USDC", () => {
  it("works on market 1, and reports its fee", async () => {
    const r = await swap(1, { recall: 1 });
    expect(r.ok, r.why).toBe(true);
    const f = r.receipt!;
    expect(Number(f.token_in_asset_id)).toBe(PEX_ASSETS.algo);
    expect(Number(f.token_out_asset_id)).toBe(PEX_ASSETS.usdc);
    const feePct = Number(f.fee_amount) / Number(f.amount_in) * 100;
    console.log(`m1 swap: ${r.txns} txns, ${f.amount_in} µALGO in, `
      + `fee ${f.fee_amount} (${feePct.toFixed(3)}%)`);
    expect(feePct).toBeLessThan(1);
  }, 120_000);

  it("works on market 2 as well, which the native with-swap path does not", async () => {
    const r = await swap(2, { recall: 1 });
    expect(r.ok, r.why).toBe(true);
    console.log(`m2 swap: ${r.txns} txns`);
  }, 120_000);

  it("needs its oracle payload targeted at SwapOps, not AdminOps", async () => {
    // The target app is inside the SIGNED bytes, so the wrong one cannot be
    // made to work by passing a different app id.
    const r = await swap(1, { recall: 1, target: PEX_APPS.adminOps });
    expect(r.ok).toBe(false);
  }, 120_000);

  it("is 4 transactions when the pool needs no recall, 7 when it does", async () => {
    // The number that decides whether a combined group fits, and it is a
    // property of the pool's idle balance rather than of the method — so it
    // must be measured per attempt, never assumed.
    /**
     * Whether a recall-free swap is possible is a property of the pool's idle
     * balance, which MOVES. Market 2 needed no recall on 2026-10-22 and did on
     * 2026-10-23; market 1 went the other way. So this asserts the
     * relationship, not the state — the same correction already made for
     * market 1 above, which this test had not received.
     */
    const withRecall = await swap(2, { recall: 1 });
    expect(withRecall.ok, withRecall.why).toBe(true);
    const without = await swap(2, { recall: 0 });
    console.log(`m2 swap: ${withRecall.txns} txns with recall; without recall `
      + `${without.ok ? `OK at ${without.txns}` : "not possible right now"}`);
    if (without.ok) expect(without.txns).toBeLessThan(withRecall.txns);

    /**
     * The arithmetic that forces the vault exit into two GROUPS, whichever
     * shape the swap takes today. Even the smallest swap observed (4) does not
     * fit beside a 15-transaction vault withdrawal.
     */
    const smallest = without.ok ? without.txns : withRecall.txns;
    expect(15 + smallest).toBeGreaterThan(MAX_GROUP_SIZE);
  }, 180_000);

  it("a recall-free swap is 4 txns, but whether one is possible moves", async () => {
    /**
     * Whether a market's swap needs a yield recall is a property of its idle
     * balance, so the transaction count — and therefore whether a combined
     * withdraw+swap group fits in 16 — changes between days. Observed on
     * market 1: recall required on 2026-10-22, not required on 2026-10-23.
     *
     * The consequence for the product: a combined group can never be SIZED in
     * advance. It has to be built and simulated per attempt, and a path that
     * only sometimes fits is not one to put behind a button.
     */
    const withRecall = await swap(1, { recall: 1 });
    expect(withRecall.ok).toBe(true);
    expect(10 + withRecall.txns).toBeGreaterThan(MAX_GROUP_SIZE);

    const without = await swap(1, { recall: 0 });
    console.log(`m1 swap: ${withRecall.txns} txns with recall; `
      + `without recall ${without.ok ? `OK at ${without.txns}` : "not possible right now"}`);
    if (without.ok) expect(without.txns).toBeLessThan(withRecall.txns);
  }, 180_000);
});
