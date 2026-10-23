/**
 * Why market 2 refuses `withdraw_liquidity_with_swap`, traced on chain.
 *
 * Written to answer a question from Ultrade: *"check if you included recall
 * when you tested market 1 but didn't with market 2"*. It did. This test holds
 * the two markets to an IDENTICAL call shape — same `yieldRecallMode: 1`, same
 * generous receipt caps, each market's own yield registry, and `outputMode: 0`
 * (NONE, no conversion at all) — and records that market 1 is accepted while
 * market 2 is refused.
 *
 * So the difference is per-market state, not our inputs.
 *
 * ── What the refusal actually is ──
 * `AdminOps pc=5582`, reached with an execution trace:
 *
 *     pc 5569  push  0x0000000000000003...   (a struct; first word = 3)
 *     pc 5572  push  680
 *     pc 5577  push  680
 *     pc 5579  extract_uint64                (read uint64 at offset 680)
 *     pc 5580  push  1
 *     pc 5581  ==
 *     pc 5582  assert                        <-- fails on market 2
 *
 * The same pattern appears twice in the disassembly, at `label42` and
 * `label47`: `extract3 0..680`, then `extract_uint64` at 680 asserted `== 1`,
 * then 16 bytes read at 688. It reads like a flag in a 696-byte envelope that
 * must be set for the with-swap path to proceed, and on market 2 it is not.
 *
 * Market 2 is a synthetic BTC index holding no BTC, so a per-market swap flag
 * being off there is plausible as intent rather than a bug — but that is
 * Ultrade's to say, and this test exists to give them the exact site.
 *
 * ── Why the refusal is ASSERTED ──
 * If Ultrade enables it, this test fails, and that failure is the signal to
 * widen `ALL_USDC_MARKETS` in group.ts. A capability that silently became
 * available would otherwise go unnoticed.
 */
import { describe, expect, it } from "vitest";
import algosdk from "algosdk";
import { buildV2WithdrawLiquidityWithSwapTransactions } from "@pdex/sdk";
import { simulateGroup } from "../../perpsGroup";
import { readQuoteContext, readRecallContext } from "../quote";
import { supportsAllUsdc } from "../group";
import { PEX_APPS, PEX_ASSETS } from "../../perps";

const algod = new algosdk.Algodv2("", "https://mainnet-api.algonode.cloud", "");
const LP = "A4YW55ZEC2TTIN2TEVN56IRVGLWQYQRUNJTPG37OTWE4EJWNAH3EUKHZKA";
/** Generous: a swap concentrates the payout, so it recalls more than a proportional exit. */
const BIG = BigInt(2_000_000_000);

/** The identical shape for both markets. Recall included, no conversion. */
async function withSwapNoConversion(marketId: number) {
  const ctx = await readQuoteContext(algod, marketId);
  const rc = await readRecallContext(algod, ctx);
  const sp = await algod.getTransactionParams().do();
  sp.fee = sp.minFee; sp.flatFee = true;
  const g = buildV2WithdrawLiquidityWithSwapTransactions({
    sender: LP, marketId, shareAmount: BigInt(92_902),
    outputMode: 0,
    minPrimaryAmount: 0, minSecondaryAmount: 0, minOutputAmount: 0,
    // Recall, as Ultrade asked about — mode 1 with THIS market's registry.
    yieldRecallMode: 1,
    maxLongReceiptAmount: BIG, maxShortReceiptAmount: BIG,
    marketYieldRegistry: rc.registry,
    oracleMessage: ctx.oracle.message, oracleSignature: ctx.oracle.signature,
    indexAssetId: marketId === 2 ? PEX_ASSETS.btcIndex : PEX_ASSETS.algo,
    longAssetId: PEX_ASSETS.algo, shortAssetId: PEX_ASSETS.usdc,
    v2MathAppId: PEX_APPS.math, v2MarketsAppId: PEX_APPS.markets,
    v2TradingAppId: PEX_APPS.trading, v2TradingRiskOpsAppId: PEX_APPS.tradingRiskOps,
    v2OrderOpsAppId: PEX_APPS.orderOps, v2AdminOpsAppId: PEX_APPS.adminOps,
    v2AdminControlAppId: PEX_APPS.adminControl, v2SwapOpsAppId: PEX_APPS.swapOps,
    v2MarketYieldVaultAppId: PEX_APPS.marketYieldVault,
    v2MarketXalgoYieldVaultAppId: PEX_APPS.marketXAlgoYieldVault,
  } as never, sp) as algosdk.Transaction[];
  return simulateGroup(algod, g);
}

describe("live: with-swap support differs by market, not by our inputs", () => {
  it("market 1 ACCEPTS the shape, recall and all", async () => {
    const r = await withSwapNoConversion(1);
    expect(r.ok, r.message).toBe(true);
  }, 120_000);

  it("market 2 REFUSES the identical shape, at the offset-680 flag", async () => {
    const r = await withSwapNoConversion(2);
    // If this starts passing, Ultrade has enabled it — widen ALL_USDC_MARKETS.
    expect(r.ok).toBe(false);
    expect(r.message).toContain("pc=5582");
    expect(r.message).toContain(String(PEX_APPS.adminOps));
    console.log(`market 2 refusal: ${String(r.message).slice(0, 150)}`);
  }, 120_000);

  it("the code's own capability list matches what the chain accepts", async () => {
    // The list in group.ts is what the UI offers. It must not drift from the
    // two results above, in either direction.
    expect(supportsAllUsdc(1)).toBe((await withSwapNoConversion(1)).ok);
    expect(supportsAllUsdc(2)).toBe((await withSwapNoConversion(2)).ok);
  }, 180_000);
});
