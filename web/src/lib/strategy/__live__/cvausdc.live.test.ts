/**
 * The single-asset C-Vault exit, end to end on MainNet.
 *
 * Both groups built, asserted and simulated. Nothing is signed, so the
 * one-prompt part is not exercised here — that is a wallet property (ARC-0001
 * `signTxns` takes an array spanning several groups). What IS exercised is
 * every claim that could be wrong on our side.
 */
import { describe, it, expect } from "vitest";
import algosdk from "algosdk";
import { readCvaSnapshot } from "../cvaSnapshot";
import { buildCvaWithdraw } from "../cvaGroup";
import { buildAlgoToUsdcSwap, assertSwapGroup, MAX_SWAP_GROUP_FEE_MICRO_ALGO } from "../swapGroup";
import { readQuoteContext, readRecallContext } from "../quote";
import { PEX_APPS } from "../../perps";

const algod = new algosdk.Algodv2("", "https://mainnet-api.algonode.cloud", "");
const HOLDER = "ALUYA2D55QDUUIY3JORBOB2B7WRTVV477R6URF4P6NY4ZZWB3LUK3DU6WE";
const ATTACKER = "7777777777777777777777777777777777777777777777777774MSJUVU";
const SLIPPAGE = 100;

async function exitAndSwap(usd: number) {
  const snap = await readCvaSnapshot(algod);
  const shareAmount = BigInt(Math.floor(usd / snap.navPerShare * 1e6));
  const exit = await buildCvaWithdraw({
    algod, sender: HOLDER, snapshot: snap, shareAmount,
    maxLongReceipt: BigInt(500_000_000), maxShortReceipt: BigInt(500_000_000),
    slippageBps: SLIPPAGE,
  });
  const algoOut = exit.receipt.fields.long_out!;
  const floorAlgo = algoOut * BigInt(10_000 - SLIPPAGE) / BigInt(10_000);
  const ctx = await readQuoteContext(algod, 1);
  const rc = await readRecallContext(algod, ctx);
  const swap = await buildAlgoToUsdcSwap({
    algod, sender: HOLDER, marketId: 1, amountInMicro: floorAlgo,
    registry: rc.registry, recall: rc.recall, slippageBps: SLIPPAGE,
  });
  return { exit, swap, algoOut, floorAlgo, rc };
}

describe("live: single-asset C-Vault exit", () => {
  it("converts the ALGO leg, and the numbers add up", async () => {
    const { exit, swap, algoOut, floorAlgo } = await exitAndSwap(10);
    expect(exit.assertion.ok).toBe(true);
    expect(swap.assertion.ok).toBe(true);

    const usdcFromExit = exit.receipt.fields.short_out!;
    const dust = algoOut - floorAlgo;
    const totalUsdc = usdcFromExit + swap.usdcOut;

    // The swap converts the FLOOR, which is the whole point: the exit is
    // guaranteed to deliver at least this, so the swap cannot starve.
    expect(swap.receipt.fields.amount_in).toBe(floorAlgo);
    expect(floorAlgo).toBeLessThan(algoOut);
    /**
     * Dust is bounded by the slippage tolerance, not open-ended.
     *
     * Asserted in integers. `floorAlgo` truncates, so the dust is the slippage
     * share PLUS up to one micro-unit — a float comparison against 1% fails on
     * that rounding, which is the test being wrong rather than the code.
     */
    expect(dust).toBeLessThanOrEqual(algoOut * BigInt(SLIPPAGE) / BigInt(10_000) + BigInt(1));
    expect(dust).toBeGreaterThan(BigInt(0));

    console.log(`$10 exit: ${exit.txns.length} + ${swap.txns.length} = `
      + `${exit.txns.length + swap.txns.length} txns in 2 groups, one prompt`);
    console.log(`  exit paid    ${(Number(algoOut) / 1e6).toFixed(6)} ALGO + `
      + `${(Number(usdcFromExit) / 1e6).toFixed(6)} USDC`);
    console.log(`  converted    ${(Number(floorAlgo) / 1e6).toFixed(6)} ALGO -> `
      + `${(Number(swap.usdcOut) / 1e6).toFixed(6)} USDC`);
    console.log(`  you receive  ${(Number(totalUsdc) / 1e6).toFixed(6)} USDC + `
      + `${(Number(dust) / 1e6).toFixed(6)} ALGO dust`);
  }, 240_000);

  it("each group is independently inside the 16-transaction cap", async () => {
    const { exit, swap } = await exitAndSwap(10);
    expect(exit.txns.length).toBeLessThanOrEqual(16);
    expect(swap.txns.length).toBeLessThanOrEqual(16);
    // And together they are not — which is why two groups, not more txns.
    expect(exit.txns.length + swap.txns.length).toBeGreaterThan(16);
  }, 240_000);

  it("CATCHES a redirected payout — the one that loses the money", async () => {
    // `receiver` is a plain argument on the call. Change it and the converted
    // USDC goes elsewhere while every amount still matches the screen, the
    // sender is still the user, and the oracle is still ours. Nothing else in
    // the assertion would notice.
    const { swap, floorAlgo, rc } = await exitAndSwap(10);
    const call = swap.txns.find((t) =>
      Number(t.applicationCall?.appIndex) === PEX_APPS.swapOps)!;
    (call.applicationCall!.appArgs as Uint8Array[])[5] =
      algosdk.decodeAddress(ATTACKER).publicKey;

    const bad = assertSwapGroup(swap.txns, {
      sender: HOLDER, marketId: 1,
      amountInMicro: floorAlgo,
      minOutMicro: swap.receipt.fields.amount_out! * BigInt(9900) / BigInt(10000),
      maxOutputReceipt: floorAlgo * BigInt(20) + BigInt(100_000_000),
      oracleMessage: new Uint8Array(133), oracleSignature: new Uint8Array(64),
      recall: rc.recall,
    });
    expect(bad.ok).toBe(false);
    expect(bad.findings.map((f) => f.code)).toContain("receiver");
  }, 240_000);

  it("CATCHES an inflated conversion amount", async () => {
    const { swap, floorAlgo, rc } = await exitAndSwap(10);
    const bad = assertSwapGroup(swap.txns, {
      sender: HOLDER, marketId: 1,
      // Claim we are converting less than the group actually converts.
      amountInMicro: floorAlgo / BigInt(2),
      minOutMicro: BigInt(0),
      maxOutputReceipt: floorAlgo * BigInt(20) + BigInt(100_000_000),
      oracleMessage: new Uint8Array(133), oracleSignature: new Uint8Array(64),
      recall: rc.recall,
    });
    expect(bad.ok).toBe(false);
    expect(bad.findings.map((f) => f.code)).toContain("amount_in");
  }, 240_000);

  it("the swap fee stays inside its cap", async () => {
    const { swap } = await exitAndSwap(10);
    const fee = swap.txns.reduce((a, t) => a + Number(t.fee), 0);
    expect(fee).toBeLessThanOrEqual(MAX_SWAP_GROUP_FEE_MICRO_ALGO);
    console.log(`swap group fee ${fee} µALGO, cap ${MAX_SWAP_GROUP_FEE_MICRO_ALGO}`);
  }, 240_000);
});
