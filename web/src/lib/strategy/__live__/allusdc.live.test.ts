/**
 * The all-USDC withdrawal, built and simulated against MainNet.
 *
 * The product decision is "everything back in USDC", so this is the default
 * path on market 1. It is the only destination that can do it in one group —
 * `supportsAllUsdc` and `swapmode.live.test.ts` have the measured reasons.
 */
import { describe, it, expect } from "vitest";
import algosdk from "algosdk";
import {
  buildWithdrawAllUsdc, assertWithdrawAllUsdcGroup, supportsAllUsdc,
  OUTPUT_MODE_ALL_USDC,
} from "@/lib/strategy/pools/group";
import { readQuoteContext, readRecallContext, quoteWithdraw, recallCaps } from "@/lib/strategy/pools/quote";
import { withdrawOutputsFor } from "@/lib/strategy/pools/client";
import { readMarketGateState } from "@/lib/strategy/pools/preflight";

const algod = new algosdk.Algodv2("", "https://mainnet-api.algonode.cloud", "");
const LP = "A4YW55ZEC2TTIN2TEVN56IRVGLWQYQRUNJTPG37OTWE4EJWNAH3EUKHZKA";

async function inputs(marketId: number, shareAmount: bigint) {
  const ctx = await readQuoteContext(algod, marketId);
  const caps = recallCaps(quoteWithdraw(ctx, shareAmount));
  const rc = await readRecallContext(algod, ctx);
  return {
    registry: rc.registry, recall: rc.recall,
    maxLongReceipt: caps.long * BigInt(20) + BigInt(100_000_000),
    maxShortReceipt: caps.short * BigInt(20) + BigInt(100_000_000),
    slippageBps: 100,
  };
}

describe("live: all-USDC withdrawal", () => {
  it("offers USDC on market 1 and only both-assets elsewhere", () => {
    expect(supportsAllUsdc(1)).toBe(true);
    expect(supportsAllUsdc(2)).toBe(false);
    expect(withdrawOutputsFor(1)).toEqual(["usdc", "both"]);
    expect(withdrawOutputsFor(2)).toEqual(["both"]);
  });

  it("pays out USDC only, and the receipt proves no ALGO", async () => {
    const st = await readMarketGateState(algod, 1, LP);
    const shareAmount = BigInt(Math.floor(st.shares * 1e6 / 10));
    const r = await buildWithdrawAllUsdc({
      algod, sender: LP, marketId: 1, shareAmount, ...(await inputs(1, shareAmount)),
    });
    expect(r.assertion.ok).toBe(true);

    const f = r.receipt.fields;
    // The promise the UI makes.
    expect(f.final_long_amount).toBe(BigInt(0));
    expect(f.final_short_amount).toBeGreaterThan(BigInt(0));
    expect(f.output_mode).toBe(OUTPUT_MODE_ALL_USDC);
    // It is the proportional USDC plus the swapped ALGO, not a truncation —
    // i.e. the user keeps the value of both legs.
    expect(f.final_short_amount)
      .toBe(f.proportional_short_out! + f.swapped_amount_out!);

    const feePct = Number(f.swap_fee_amount) / Number(f.swapped_amount_out) * 100;
    console.log(`all-USDC: ${f.proportional_long_out} µALGO + ${f.proportional_short_out} µUSDC `
      + `-> ${f.final_short_amount} µUSDC | swap fee ${f.swap_fee_amount} `
      + `(${feePct.toFixed(2)}% of the converted part) | ${r.txns.length} txns, `
      + `${r.txns.reduce((a, t) => a + Number(t.fee), 0)} µALGO`);
    console.log("checks:", r.assertion.checked);
  }, 120_000);

  it("catches a downgrade to both-assets after display", async () => {
    // The nastiest tamper on this path: flip output_mode to 0 and the user
    // receives ALGO as well, having been told it would all be USDC. The
    // amounts would all still match.
    const st = await readMarketGateState(algod, 1, LP);
    const shareAmount = BigInt(Math.floor(st.shares * 1e6 / 10));
    const ins = await inputs(1, shareAmount);
    const r = await buildWithdrawAllUsdc({
      algod, sender: LP, marketId: 1, shareAmount, ...ins,
    });
    const call = r.txns.find((t) =>
      t.type === "appl" && Number(t.applicationCall?.appIndex) === 3690309162)!;
    (call.applicationCall!.appArgs as Uint8Array[])[3] = algosdk.encodeUint64(BigInt(0));

    const bad = assertWithdrawAllUsdcGroup(r.txns, {
      sender: LP, marketId: 1, shareAmount,
      minUsdcMicro: r.receipt.fields.final_short_amount!,
      maxLongReceipt: ins.maxLongReceipt, maxShortReceipt: ins.maxShortReceipt,
      oracleMessage: new Uint8Array(133), oracleSignature: new Uint8Array(64),
      recall: ins.recall,
    });
    expect(bad.ok).toBe(false);
    expect(bad.findings.map((x) => x.code)).toContain("output_mode");
  }, 120_000);

  it("refuses to build for a market that cannot pay one asset", async () => {
    await expect(buildWithdrawAllUsdc({
      algod, sender: LP, marketId: 2, shareAmount: BigInt(1000),
      ...(await inputs(2, BigInt(1000))),
    })).rejects.toThrow(/single asset/);
  }, 120_000);
});
