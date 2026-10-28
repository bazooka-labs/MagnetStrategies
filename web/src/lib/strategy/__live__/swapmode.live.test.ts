/**
 * Which single-asset withdrawal options PEX actually supports.
 *
 * `withdraw_liquidity_with_swap(market_id, share_amount, output_mode, ...)`
 * exists on AdminOps and pays a withdrawal out in ONE asset instead of two.
 * This test pins what each mode does, and — more importantly — which
 * combinations the chain refuses, because the matrix is narrower than the
 * method's existence suggests.
 *
 * ── The mode constants do NOT describe LP semantics ──
 * `V2_OUTPUT_SWAP` is `{NONE:0, PNL_TO_COLLATERAL:1, COLLATERAL_TO_PNL:2}`,
 * names borrowed from the position-close path. On an LP withdrawal, mode 2 pays
 * **everything in USDC** — the opposite of what "COLLATERAL_TO_PNL" reads like.
 * Determined by simulating and reading the receipt, not from the names.
 *
 * ── The matrix, measured 2026-10-22 ──
 *
 *   market 1 (ALGO/USD)   mode 0 both   OK
 *                         mode 1 ALGO   INTERMITTENT — depends on pool idle
 *                         mode 2 USDC   OK (stable)
 *   market 2 (BTC/USD)    every mode    REFUSED — method unsupported on this market
 *   C-Vault               n/a           no swap method exists at all (20 methods, none)
 *
 * So the only single-asset option that works RELIABLY is **all-USDC on market
 * 1**. All-ALGO works only when the pool can pay without a yield recall, which
 * is a balance condition rather than a capability — see the test below.
 */
import { describe, it, expect } from "vitest";
import algosdk from "algosdk";
import {
  buildV2WithdrawLiquidityWithSwapTransactions, V2_OUTPUT_SWAP, decodeReceipt,
} from "@pdex/sdk";
import { simulateGroup } from "@/lib/strategy/pex/group";
import { readQuoteContext, readRecallContext, quoteWithdraw, recallCaps } from "@/lib/strategy/pools/quote";
import { PEX_APPS, PEX_ASSETS } from "@/lib/strategy/pex/config";

const algod = new algosdk.Algodv2("", "https://mainnet-api.algonode.cloud", "");
const LP = "A4YW55ZEC2TTIN2TEVN56IRVGLWQYQRUNJTPG37OTWE4EJWNAH3EUKHZKA";
/** Generous: a swap concentrates the payout, so it recalls more of one leg. */
const BIG = BigInt(2_000_000_000);

type Outcome = { ok: boolean; fields?: Record<string, unknown>; why?: string };

async function trySwapWithdraw(marketId: number, mode: number): Promise<Outcome> {
  const ctx = await readQuoteContext(algod, marketId);
  const caps = recallCaps(quoteWithdraw(ctx, BigInt(92_902)));
  void caps;
  const rc = await readRecallContext(algod, ctx);
  const sp = await algod.getTransactionParams().do();
  sp.fee = sp.minFee; sp.flatFee = true;
  try {
    const g = buildV2WithdrawLiquidityWithSwapTransactions({
      sender: LP, marketId, shareAmount: BigInt(92_902),
      outputMode: mode,
      minPrimaryAmount: 0, minSecondaryAmount: 0, minOutputAmount: 0,
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
    const r = await simulateGroup(algod, g);
    if (!r.ok) return { ok: false, why: String(r.message) };
    for (const log of r.logs ?? []) {
      if (Buffer.from(log.slice(0, 4)).toString("hex") !== "151f7c75") continue;
      const body = log.slice(4);
      const len = (body[0] << 8) | body[1];
      try {
        const rec = decodeReceipt(body.slice(2, 2 + len)) as unknown as
          { eventType?: string; fields?: Record<string, unknown> };
        if (rec.eventType === "v2_lp_withdraw_with_swap") return { ok: true, fields: rec.fields };
      } catch { /* not a receipt */ }
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, why: (e as Error).message };
  }
}

describe("live: single-asset withdrawal support", () => {
  it("market 1 mode 2 pays out ONLY USDC, and charges a swap fee", async () => {
    const r = await trySwapWithdraw(1, V2_OUTPUT_SWAP.COLLATERAL_TO_PNL);
    expect(r.ok, r.why).toBe(true);
    const f = r.fields!;
    // The whole point: nothing in the long asset.
    expect(Number(f.final_long_amount)).toBe(0);
    expect(Number(f.final_short_amount)).toBeGreaterThan(0);
    // And it is the proportional short PLUS the swapped long, not a truncation.
    expect(Number(f.final_short_amount))
      .toBe(Number(f.proportional_short_out) + Number(f.swapped_amount_out));
    expect(Number(f.swapped_token_out)).toBe(PEX_ASSETS.usdc);
    // A swap is not free; the UI must show this.
    expect(Number(f.swap_fee_amount)).toBeGreaterThan(0);
    const feePct = Number(f.swap_fee_amount) / Number(f.swapped_amount_out) * 100;
    console.log(`market 1 all-USDC: ${f.proportional_long_out} µALGO + `
      + `${f.proportional_short_out} µUSDC  ->  ${f.final_short_amount} µUSDC `
      + `(swapped ${f.swapped_amount_in} µALGO for ${f.swapped_amount_out}, `
      + `fee ${f.swap_fee_amount} = ${feePct.toFixed(2)}% of the swapped part)`);
  }, 120_000);

  it("market 1 mode 0 still pays out both, unchanged", async () => {
    const r = await trySwapWithdraw(1, V2_OUTPUT_SWAP.NONE);
    expect(r.ok, r.why).toBe(true);
    const f = r.fields!;
    expect(Number(f.final_long_amount)).toBe(Number(f.proportional_long_out));
    expect(Number(f.final_short_amount)).toBe(Number(f.proportional_short_out));
    expect(Number(f.swap_fee_amount)).toBe(0);
  }, 120_000);

  it("market 1 all-ALGO is INTERMITTENT — a function of pool state, not capability", async () => {
    /**
     * This test asserted a flat refusal for one day and then failed, which is
     * exactly what it was written to do.
     *
     * 2026-10-22: refused in every cap shape. With the short leg recalled it
     * hit a resource-reference limit inside the Folks USDC vault
     * (`axfer AssetReceiver: unavailable Holding 31566704+<markets addr>`);
     * without it, the recall cap assert at Markets pc=12259.
     * 2026-10-23: **succeeds**.
     *
     * The difference is the pool's idle USDC. When there is enough, no Folks
     * recall happens and the resource that could not be referenced is never
     * needed. So all-ALGO is not unsupported — it is available only when the
     * pool happens to be able to pay without a recall, which is not something
     * to advertise in a UI.
     *
     * We therefore do NOT offer all-ALGO. This test documents the behaviour
     * and asserts only that the outcome is one of the two understood ones, so
     * it stops breaking on a balance change while still catching a NEW
     * failure mode.
     */
    const r = await trySwapWithdraw(1, V2_OUTPUT_SWAP.PNL_TO_COLLATERAL);
    if (r.ok) {
      console.log("market 1 all-ALGO: available right now (pool needs no recall)");
      expect(Number(r.fields!.final_short_amount)).toBe(0);
      expect(Number(r.fields!.final_long_amount)).toBeGreaterThan(0);
    } else {
      console.log(`market 1 all-ALGO: unavailable right now — ${String(r.why).slice(0, 100)}`);
      expect(String(r.why)).toMatch(/unavailable Holding|pc=12259/);
    }
  }, 120_000);

  it("market 2 does not support the with-swap method at all", async () => {
    // Every mode, including NONE, fails an equality assert at AdminOps
    // pc=5582. Market 2 is a synthetic BTC index holding no BTC, so there is
    // nothing to swap against. The plain `withdraw_liquidity` is unaffected.
    for (const mode of [0, 1, 2]) {
      const r = await trySwapWithdraw(2, mode);
      expect(r.ok, `mode ${mode} unexpectedly succeeded`).toBe(false);
    }
  }, 180_000);
});
